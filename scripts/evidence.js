#!/usr/bin/env node
// Investigator tool for the encrypted evidence store.
//
//   keygen  [--out keys/evidence-private.key]
//       Create the evidence key pair. The private key is passphrase-protected;
//       store it (and the passphrase) somewhere safe, e.g. Bitwarden. Prints the
//       public key + key_id to paste into the policy's "evidence" block.
//
//   list    [--evidence collector/data/evidence.ndjson]
//       List evidence records (metadata only, nothing is decrypted).
//
//   view <evidence-id> --analyst NAME --reason "WHY" [--key PATH] [--evidence FILE] [--audit FILE]
//       Decrypt one record. Every view is written to a hash-chained access log
//       BEFORE the content is shown. Passphrase from PG_EVIDENCE_PASSPHRASE or prompt.
//
//   verify-audit [--audit collector/data/evidence-access.log]
//       Check the access log hasn't been edited or had entries removed.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");
const { safeText } = require("./safe-text.js");

const ROOT = path.join(__dirname, "..");
const DEFAULTS = {
  key: path.join(ROOT, "keys", "evidence-private.key"),
  evidence: path.join(ROOT, "collector", "data", "evidence.ndjson"),
  audit: path.join(ROOT, "collector", "data", "evidence-access.log"),
};

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function askHidden(question) {
  if (process.env.PG_EVIDENCE_PASSPHRASE) return Promise.resolve(process.env.PG_EVIDENCE_PASSPHRASE);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

function keyIdFor(spkiDer) {
  return crypto.createHash("sha256").update(spkiDer).digest("hex").slice(0, 16);
}

// ---------- private key file: scrypt + AES-256-GCM ----------
// Node's built-in passphrase PEM uses PBKDF2 with only 2,048 iterations, which
// makes offline passphrase guessing cheap if the key file is stolen. We wrap
// the PKCS#8 key ourselves with scrypt (memory-hard, N=2^17) instead.
const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

function sealPrivateKey(pkcs8Der, pass) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const k = crypto.scryptSync(pass, salt, 32, SCRYPT);
  const c = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([c.update(pkcs8Der), c.final()]);
  return JSON.stringify({
    format: "prompt-guard-evidence-key/1", kdf: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    salt: salt.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"),
    key: ct.toString("base64"),
  }, null, 2) + "\n";
}

function openPrivateKey(fileText, pass) {
  if (fileText.trimStart().startsWith("-----BEGIN")) {
    // Legacy PEM from earlier builds (weak PBKDF2). Still readable, but say so.
    console.error("Warning: this key file uses the old, weaker passphrase protection. Generate a new key with keygen when convenient.");
    return crypto.createPrivateKey({ key: fileText, format: "pem", passphrase: pass });
  }
  const f = JSON.parse(fileText);
  if (f.kdf !== "scrypt") throw new Error("unknown key format");
  const k = crypto.scryptSync(pass, Buffer.from(f.salt, "base64"), 32, { N: f.N, r: f.r, p: f.p, maxmem: SCRYPT.maxmem });
  const d = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(f.iv, "base64"));
  d.setAuthTag(Buffer.from(f.tag, "base64"));
  const der = Buffer.concat([d.update(Buffer.from(f.key, "base64")), d.final()]); // throws on wrong passphrase
  return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

const publicJsonPath = (keyPath) => keyPath.replace(/\.(pem|key)$/, "") + ".public.json";

async function keygen(a) {
  const out = a.out || DEFAULTS.key;
  if (fs.existsSync(out)) die(`${out} already exists. Refusing to overwrite a key that may protect existing evidence.`);
  const pass = await askHidden("New passphrase for the private key (min 12 chars): ");
  if (!pass || pass.length < 12) die("Passphrase too short.");
  if (!process.env.PG_EVIDENCE_PASSPHRASE) {
    const again = await askHidden("Repeat passphrase: ");
    if (again !== pass) die("Passphrases don't match.");
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, sealPrivateKey(privateKey, pass), { mode: 0o600 });
  privateKey.fill(0);
  const spki = publicKey.toString("base64");
  const keyId = keyIdFor(publicKey);
  fs.writeFileSync(publicJsonPath(out), JSON.stringify({ public_key_spki: spki, key_id: keyId }, null, 2) + "\n");
  console.log(`Private key written to ${out} (encrypted with your passphrase, mode 600).`);
  console.log("Store the key file and passphrase safely (e.g. Bitwarden). Lose them = evidence is unreadable.\n");
  console.log("Paste this into the policy:\n");
  console.log(JSON.stringify({ evidence: { enabled: true, public_key_spki: spki, key_id: keyId } }, null, 2));
}

function readEvidence(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function list(a) {
  const recs = readEvidence(a.evidence || DEFAULTS.evidence);
  if (!recs.length) return console.log("No evidence records.");
  for (const r of recs) {
    console.log([r.id, r["@timestamp"], r["user.name"], r["host.name"], r["ai.site"], r["event.action"]].join("\t"));
  }
}

// ---------- hash-chained access log (shared with the admin dashboard) ----------

const audit = require("../collector/audit.js");

function verifyAudit(a) {
  const file = a.audit || DEFAULTS.audit;
  const r = audit.verify(file);
  if (!r.ok) {
    console.log(`TAMPERED: access log broken at entry ${r.brokenAt}`);
    process.exit(2);
  }
  console.log(`OK: ${r.entries} access log entries, chain intact`);
}

// ---------- decrypt ----------

async function view(a) {
  const id = a._[1];
  if (!id) die("usage: view <evidence-id> --analyst NAME --reason \"WHY\"");
  if (!a.analyst) die("--analyst is required.");
  if (!a.reason || a.reason.trim().length < 10) die("--reason is required (at least 10 characters, e.g. an incident or ticket number).");

  const rec = readEvidence(a.evidence || DEFAULTS.evidence).find((r) => r.id === id);
  if (!rec) die(`No evidence record ${id} (it may have passed the retention period).`);

  const keyText = fs.readFileSync(a.key || DEFAULTS.key, "utf8");
  const pass = await askHidden("Private key passphrase: ");
  let key;
  try {
    key = openPrivateKey(keyText, pass);
  } catch (_) {
    die("Wrong passphrase or unreadable key.");
  }
  const spki = crypto.createPublicKey(key).export({ type: "spki", format: "der" });
  if (keyIdFor(spki) !== rec.key_id) die(`This record was encrypted with key ${rec.key_id}; that's not this key.`);

  // Log the access BEFORE showing anything.
  audit.append(a.audit || DEFAULTS.audit, {
    at: new Date().toISOString(),
    analyst: a.analyst,
    reason: a.reason.trim(),
    evidence_id: id,
    subject_user: rec["user.name"],
    os_user: process.env.USER || null,
  });

  const aesKey = crypto.privateDecrypt(
    { key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(rec.wrapped_key, "base64"));
  const blob = Buffer.from(rec.ciphertext, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, Buffer.from(rec.iv, "base64"));
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  const plain = JSON.parse(Buffer.concat([decipher.update(blob.subarray(0, blob.length - 16)), decipher.final()]).toString("utf8"));

  // Everything below is untrusted (written by users): sanitise before printing.
  const t = safeText;
  console.log(`Evidence ${t(id)}`);
  console.log(`  when:   ${t(rec["@timestamp"])}`);
  console.log(`  user:   ${t(rec["user.name"])} on ${t(rec["host.name"])}`);
  console.log(`  site:   ${t(rec["ai.site"])}   action: ${t(rec["event.action"])}`);
  console.log("\nOriginal text:\n" + t(plain.original_text) + "\n");
  console.log("Values:");
  for (const v of plain.values || []) console.log(`  ${t(v.placeholder).padEnd(20)} ${t(v.type).padEnd(14)} ${t(v.value)}`);
  if (plain.justification) console.log(`\nOverride justification: ${t(plain.justification)}`);
  console.log("\n(This access has been recorded in the evidence access log.)");
}

(async () => {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  if (cmd === "keygen") return keygen(a);
  if (cmd === "list") return list(a);
  if (cmd === "view") return view(a);
  if (cmd === "verify-audit") return verifyAudit(a);
  die("usage: evidence.js keygen | list | view <id> --analyst NAME --reason WHY | verify-audit");
})();
