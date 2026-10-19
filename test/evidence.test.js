const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const store = require("../collector/evidence-store.js");

const CLI = path.join(__dirname, "../scripts/evidence.js");
const PASS = "correct horse battery staple";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pg-evidence-"));
const KEY = path.join(tmp, "evidence-private.key");
const EVIDENCE = path.join(tmp, "evidence.ndjson");
const AUDIT = path.join(tmp, "access.log");

function cli(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, PG_EVIDENCE_PASSPHRASE: PASS, ...env }, encoding: "utf8",
  });
}

// Encrypt the way the extension does (WebCrypto RSA-OAEP-256 + AES-256-GCM).
async function encryptLikeExtension(plain, spkiB64) {
  const { subtle } = globalThis.crypto;
  const pub = await subtle.importKey("spki", Buffer.from(spkiB64, "base64"), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const aes = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = crypto.randomBytes(12);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, aes, Buffer.from(JSON.stringify(plain)));
  const wrapped = await subtle.encrypt({ name: "RSA-OAEP" }, pub, await subtle.exportKey("raw", aes));
  const keyId = crypto.createHash("sha256").update(Buffer.from(spkiB64, "base64")).digest("hex").slice(0, 16);
  return { alg: "RSA-OAEP-256+A256GCM", key_id: keyId, wrapped_key: Buffer.from(wrapped).toString("base64"),
    iv: iv.toString("base64"), ciphertext: Buffer.from(ct).toString("base64") };
}

let pub;

test("keygen writes a passphrase-protected key and the public key for the policy", () => {
  const r = cli(["keygen", "--out", KEY]);
  assert.equal(r.status, 0, r.stderr);
  const f = JSON.parse(fs.readFileSync(KEY, "utf8"));
  assert.equal(f.kdf, "scrypt");
  assert.ok(f.N >= 1 << 17, "memory-hard KDF with a strong work factor");
  assert.ok(!fs.readFileSync(KEY, "utf8").includes("PRIVATE KEY"), "no unencrypted key material");
  assert.equal(fs.statSync(KEY).mode & 0o777, 0o600);
  pub = JSON.parse(fs.readFileSync(KEY.replace(/\.key$/, "") + ".public.json", "utf8"));
  assert.match(pub.key_id, /^[0-9a-f]{16}$/);
  assert.equal(cli(["keygen", "--out", KEY]).status, 1, "must refuse to overwrite an existing key");
});

test("split() moves valid evidence out of the event and rejects plain text", async () => {
  const ev = await encryptLikeExtension({ original_text: "x" }, pub.public_key_spki);
  const id = crypto.randomUUID();
  const event = { "@timestamp": "2026-10-07T10:00:00Z", "evidence.id": id, evidence: ev, "user.name": "u" };
  const rec = store.split(event);
  assert.equal(rec.id, id);
  assert.equal(event.evidence, undefined);
  assert.equal(event["evidence.present"], true);

  const sneaky = { "evidence.id": crypto.randomUUID(), evidence: { ...ev, ciphertext: "client 8001015009087 !!" } };
  assert.equal(store.split(sneaky), null);
  assert.equal(sneaky["evidence.error"], "rejected_invalid_evidence");
  assert.equal(sneaky.evidence, undefined);
});

test("view decrypts, requires a reason, and logs the access first", async () => {
  const ev = await encryptLikeExtension({
    original_text: "Check client 8001015009087 for FICA",
    values: [{ placeholder: "[SA_ID_NUMBER_1]", type: "SA_ID_NUMBER", value: "8001015009087" }],
  }, pub.public_key_spki);
  const id = crypto.randomUUID();
  const rec = store.split({ "@timestamp": "2026-10-07T10:00:00Z", "evidence.id": id, evidence: ev,
    "user.name": "tnkosi", "host.name": "LT-1", "ai.site": "chatgpt.com", "event.action": "prompt_sent_redacted" });
  store.append(EVIDENCE, [rec]);

  const common = ["view", id, "--key", KEY, "--evidence", EVIDENCE, "--audit", AUDIT];
  assert.equal(cli([...common, "--analyst", "will"]).status, 1, "no reason -> refused");
  assert.equal(cli([...common, "--analyst", "will", "--reason", "short"]).status, 1, "too-short reason -> refused");
  assert.equal(cli([...common, "--analyst", "will", "--reason", "INC-1042 FICA leak review"], { PG_EVIDENCE_PASSPHRASE: "wrong passphrase!!" }).status, 1);
  assert.equal(fs.existsSync(AUDIT), false, "failed attempts don't decrypt anything");

  const ok = cli([...common, "--analyst", "will", "--reason", "INC-1042 FICA leak review"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Check client 8001015009087 for FICA/);
  assert.match(ok.stdout, /\[SA_ID_NUMBER_1\]\s+SA_ID_NUMBER\s+8001015009087/);
  const audit = fs.readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].analyst, "will");
  assert.equal(audit[0].reason, "INC-1042 FICA leak review");
  assert.equal(audit[0].subject_user, "tnkosi");
});

test("verify-audit detects edited or deleted access log entries", () => {
  // add a second entry
  const id = JSON.parse(fs.readFileSync(EVIDENCE, "utf8").trim().split("\n")[0]).id;
  cli(["view", id, "--key", KEY, "--evidence", EVIDENCE, "--audit", AUDIT, "--analyst", "sam", "--reason", "Second look for INC-1042"]);
  assert.equal(cli(["verify-audit", "--audit", AUDIT]).status, 0);

  const lines = fs.readFileSync(AUDIT, "utf8").trim().split("\n");
  const edited = JSON.parse(lines[0]);
  edited.analyst = "someone-else";
  fs.writeFileSync(AUDIT, [JSON.stringify(edited), lines[1]].join("\n") + "\n");
  assert.equal(cli(["verify-audit", "--audit", AUDIT]).status, 2, "edit detected");

  fs.writeFileSync(AUDIT, lines[1] + "\n");
  assert.equal(cli(["verify-audit", "--audit", AUDIT]).status, 2, "deleted first entry detected");
});

test("purgeOld removes evidence past retention and keeps recent records", () => {
  const f = path.join(tmp, "purge.ndjson");
  const now = Date.parse("2026-10-07T00:00:00Z");
  const rec = (daysAgo) => JSON.stringify({ id: String(daysAgo), stored_at: new Date(now - daysAgo * 86400000).toISOString() });
  fs.writeFileSync(f, [rec(1), rec(29), rec(31), rec(90)].join("\n") + "\n");
  assert.equal(store.purgeOld(f, 30, now), 2);
  const left = fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l).id);
  assert.deepEqual(left, ["1", "29"]);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
