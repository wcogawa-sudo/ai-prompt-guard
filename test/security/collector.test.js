// Security tests for the collector and admin dashboard: each one checks a
// protection actually holds, so regressions show up in `npm run security`.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { safeText } = require("../../scripts/safe-text.js");

const SERVER = path.join(__dirname, "../../collector/server.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pg-sec-"));
const TOKEN = "security-test-token-0123456789";
const procs = [];

function start(env) {
  const port = 19000 + Math.floor(Math.random() * 900);
  const p = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PG_TOKEN: TOKEN, PG_PORT: String(port), PG_OUT: path.join(tmp, `ev-${port}.ndjson`), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(p);
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { out += d; });
  return new Promise((resolve, reject) => {
    const t = setInterval(() => { if (out.includes("collector on")) { clearInterval(t); resolve({ port, out: () => out, file: path.join(tmp, `ev-${port}.ndjson`) }); } }, 50);
    p.on("exit", (code) => { clearInterval(t); reject(Object.assign(new Error(`exited ${code}`), { out })); });
  });
}
const post = (port, body, headers) => fetch(`http://127.0.0.1:${port}/events`, {
  method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...headers }, body,
});
const basic = (u, p) => ({ Authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") });

test.after(() => { for (const p of procs) p.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("forged server-owned fields are dropped; oversized strings truncated and flagged", async () => {
  const c = await start({});
  const r = await post(c.port, JSON.stringify([{ "event.action": "x", "evidence.present": true, "source.ip": "6.6.6.6",
    "collector.rescrubbed": false, "prompt.redacted": "a".repeat(150000) }]));
  assert.equal(r.status, 200);
  const ev = JSON.parse(fs.readFileSync(c.file, "utf8").trim());
  assert.equal(ev["evidence.present"], undefined);
  assert.notEqual(ev["source.ip"], "6.6.6.6");
  assert.equal(ev["prompt.redacted"].length, 100000);
  assert.equal(ev["collector.truncated"], true);
});

test("batches over 1000 events are refused", async () => {
  const c = await start({});
  const r = await post(c.port, JSON.stringify(Array.from({ length: 1001 }, () => ({ a: 1 }))));
  assert.equal(r.status, 400);
});

test("rate limit: too many requests from one address get 429", async () => {
  const c = await start({ PG_RATE_PER_MIN: "5" });
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await post(c.port, "[]")).status);
  assert.deepEqual(codes.slice(0, 5), [200, 200, 200, 200, 200]);
  assert.equal(codes[6], 429);
});

test("CORS only allows the extension's origin, never a wildcard", async () => {
  const c = await start({});
  const r = await post(c.port, "[]", { Origin: "https://evil.example" });
  assert.equal(r.headers.get("access-control-allow-origin"), "chrome-extension://nkfbgnhhnhdpimbkgkbeddiijbeoklgc");
});

test("admin: strict CSP (no inline scripts) and anti-framing headers", async () => {
  const c = await start({ PG_ADMIN_PASSWORD: "a-strong-admin-pass" });
  const r = await fetch(`http://127.0.0.1:${c.port}/admin`, { headers: basic("admin", "a-strong-admin-pass") });
  assert.equal(r.status, 200);
  const csp = r.headers.get("content-security-policy");
  const scriptSrc = csp.split(";").find((x) => x.trim().startsWith("script-src"));
  assert.equal(scriptSrc.trim(), "script-src 'self'");
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.ok(!(await r.text()).match(/<script>(?!<\/)/), "no inline <script> blocks in the page");
});

test("admin: login locks out after 10 failed attempts (even the right password)", async () => {
  const c = await start({ PG_ADMIN_PASSWORD: "a-strong-admin-pass" });
  const url = `http://127.0.0.1:${c.port}/admin/api/summary`;
  for (let i = 0; i < 10; i++) assert.equal((await fetch(url, { headers: basic("admin", `guess${i}`) })).status, 401);
  assert.equal((await fetch(url, { headers: basic("admin", "a-strong-admin-pass") })).status, 429);
});

test("exposed collector: refuses a short token", () => {
  const r = spawnSync(process.execPath, [SERVER], { env: { ...process.env, PG_TOKEN: "short", PG_HOST: "0.0.0.0", PG_PORT: "19999", PG_OUT: path.join(tmp, "x.ndjson") }, encoding: "utf8", timeout: 5000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /at least 24 characters/);
});

test("exposed collector: weak/lab admin password disables the dashboard", async () => {
  const c = await start({ PG_HOST: "0.0.0.0", PG_ADMIN_PASSWORD: "lab-admin" });
  assert.match(c.out(), /Admin dashboard DISABLED/);
  assert.match(c.out(), /plain HTTP/);
  const r = await fetch(`http://127.0.0.1:${c.port}/admin`, { headers: basic("admin", "lab-admin") });
  assert.equal(r.status, 503);
});

test("terminal output: escape sequences and bidi overrides are neutralised", () => {
  const out = safeText("hi\x1b[2J\x1b]0;pwned\x07 ‮TXT.EXE\nnext\tline");
  assert.ok(!/[\x1b\x07‮]/.test(out));
  assert.match(out, /\\u\{1b\}/);
  assert.ok(out.includes("\nnext\tline"), "newlines and tabs kept");
});

test("secrets: private key files are git-ignored", () => {
  const root = path.join(__dirname, "../..");
  for (const f of ["keys/extension-key.pem", "keys/evidence-private.key", "collector/data/events.ndjson"]) {
    const r = spawnSync("git", ["check-ignore", "-q", f], { cwd: root });
    assert.equal(r.status, 0, `${f} must be git-ignored`);
  }
});

test("reveal endpoint: POST + JSON only, same-origin only, needs analyst + reason", async () => {
  const c = await start({ PG_ADMIN_PASSWORD: "a-strong-admin-pass" });
  const url = `http://127.0.0.1:${c.port}/admin/api/evidence/reveal`;
  const auth = basic("admin", "a-strong-admin-pass");
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal((await fetch(url, { headers: auth })).status, 405, "GET refused");
  const body = JSON.stringify({ id, analyst: "x", reason: "a good reason here" });
  assert.equal((await fetch(url, { method: "POST", headers: { ...auth, "Content-Type": "text/plain" }, body })).status, 403, "non-JSON (simple cross-site form) refused");
  assert.equal((await fetch(url, { method: "POST", headers: { ...auth, "Content-Type": "application/json", Origin: "https://evil.example" }, body })).status, 403, "cross-origin refused");
  assert.equal((await fetch(url, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ id, analyst: "x", reason: "short" }) })).status, 400, "reason required");
  assert.equal((await fetch(url, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body })).status, 404, "unknown id");
  assert.equal((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body })).status, 401, "login required");
});

test("dashboard decrypts in the browser: crypto matches the key tool (RFC 7914 scrypt)", async () => {
  const C = require("../../collector/admin-crypto.js");
  const v = Buffer.from(await C.scrypt(new TextEncoder().encode("password"), new TextEncoder().encode("NaCl"), 1024, 8, 16, 64)).toString("hex");
  assert.ok(v.startsWith("fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b373162"));
});
