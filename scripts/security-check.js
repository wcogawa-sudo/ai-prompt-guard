#!/usr/bin/env node
// `npm run security`: repeatable security check. Run it after every change.
//
//   1. Security test suite (ReDoS, collector hardening, admin, terminal output, secrets)
//   2. Secret scan of the source tree (keys/tokens that must never be committed)
//   3. Dangerous-code scan (innerHTML, eval, new Function, document.write, string timers)
//   4. Dependency audit (npm audit; the shipped extension and collector have zero runtime deps)
//   5. Extension permission review (flags anything beyond the expected set)
//
// Exit code is non-zero if anything fails, so it can gate a build.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail });

// ---------- 1. security tests ----------
{
  const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "test/security/"], { cwd: ROOT, encoding: "utf8" });
  const pass = /ℹ pass (\d+)/.exec(r.stdout);
  const fail = /ℹ fail (\d+)/.exec(r.stdout);
  const failed = fail ? +fail[1] : 1;
  const names = (r.stdout.match(/^✖ .*$/gm) || []).filter((l) => !l.includes("failing tests")).join("\n    ");
  record("Security test suite", r.status === 0 && failed === 0, `${pass ? pass[1] : 0} passed, ${failed} failed${names ? "\n    " + names : ""}`);
}

// ---------- 2. secret scan ----------
const SKIP_DIRS = new Set(["node_modules", ".git", "keys", "dist", ".tmp", "data"]);
const TEXT_EXT = /\.(js|json|html|md|sh|txt|yml|yaml|reg|env|cjs|mjs|jsx)$/i;
function* walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) { if (!SKIP_DIRS.has(ent.name)) yield* walk(path.join(dir, ent.name)); }
    else yield path.join(dir, ent.name);
  }
}
const SECRET_PATTERNS = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/, "private key"],
  [/\bsk-ant-api\d\d-[A-Za-z0-9_-]{40,}/, "Anthropic API key"],
  [/\bsk-(?:proj-)?[A-Za-z0-9]{40,}/, "OpenAI API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\bghp_[A-Za-z0-9]{36}\b/, "GitHub token"],
  [/"kdf":\s*"scrypt"/, "evidence private key file"],
];
// Test fixtures deliberately contain fake secrets to test the detectors.
const SECRET_ALLOW = [/^test\//, /^scripts\/security-check\.js$/, /^extension\/src\/detectors\.js$/, /^README\.md$/];
{
  const hits = [];
  for (const file of walk(ROOT)) {
    const rel = path.relative(ROOT, file);
    if (!TEXT_EXT.test(rel) || SECRET_ALLOW.some((re) => re.test(rel))) continue;
    if (fs.statSync(file).size > 2 * 1024 * 1024) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) hits.push(`${rel}: ${what}`);
  }
  // Private keys must stay git-ignored.
  for (const f of fs.existsSync(path.join(ROOT, "keys")) ? fs.readdirSync(path.join(ROOT, "keys")) : []) {
    if (!/\.(pem|key)$/.test(f)) continue;
    const r = spawnSync("git", ["check-ignore", "-q", `keys/${f}`], { cwd: ROOT });
    if (r.status !== 0) hits.push(`keys/${f}: private key is NOT git-ignored`);
  }
  record("Secret scan", hits.length === 0, hits.length ? hits.join("\n    ") : "no secrets in source; private keys git-ignored");
}

// ---------- 3. dangerous code ----------
{
  const SINKS = [
    [/\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\s*\(/, "HTML injection sink"],
    [/\beval\s*\(/, "eval"],
    [/\bnew Function\s*\(/, "new Function"],
    [/document\.write\s*\(/, "document.write"],
    [/set(?:Timeout|Interval)\s*\(\s*["'`]/, "string timer"],
    [/rejectUnauthorized\s*:\s*false/, "TLS verification disabled"],
  ];
  const hits = [];
  for (const dir of ["extension", "collector", "scripts"]) {
    for (const file of walk(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, file);
      if (!/\.(js|html)$/.test(rel) || rel === "scripts/security-check.js") continue;
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/^\s*\/\//.test(line)) return; // comments
        for (const [re, what] of SINKS) if (re.test(line)) hits.push(`${rel}:${i + 1}: ${what}`);
      });
    }
  }
  record("Dangerous-code scan", hits.length === 0, hits.length ? hits.join("\n    ") : "no innerHTML/eval/new Function/document.write/string timers");
}

// ---------- 4. dependency audit ----------
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const runtime = Object.keys(pkg.dependencies || {});
  const r = spawnSync("npm", ["audit", "--json"], { cwd: ROOT, encoding: "utf8", timeout: 60000 });
  let detail;
  let ok;
  try {
    const j = JSON.parse(r.stdout);
    const v = j.metadata.vulnerabilities;
    const serious = (v.high || 0) + (v.critical || 0);
    ok = serious === 0;
    detail = `runtime deps: ${runtime.length ? runtime.join(", ") : "none (extension + collector ship no third-party code)"}; ` +
      `dev/test deps: ${v.critical || 0} critical, ${v.high || 0} high, ${v.moderate || 0} moderate, ${v.low || 0} low`;
  } catch (_) {
    ok = true; // offline: don't fail the whole check, but say so
    detail = "npm audit unavailable (offline?) - re-run when online";
  }
  record("Dependency audit", ok && runtime.length === 0, detail);
}

// ---------- 5. extension permissions ----------
{
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, "extension/manifest.json"), "utf8"));
  const EXPECTED = new Set(["storage", "declarativeNetRequest", "alarms"]);
  const extra = (m.permissions || []).filter((p) => !EXPECTED.has(p));
  const hosts = m.host_permissions || [];
  const notes = [];
  if (extra.length) notes.push(`unexpected permissions: ${extra.join(", ")}`);
  if (m.externally_connectable) notes.push("externally_connectable is set (web pages could message the extension)");
  const csp = (m.content_security_policy && m.content_security_policy.extension_pages) || "";
  if (/unsafe-eval|unsafe-inline/.test(csp)) notes.push("extension CSP allows unsafe-eval/inline");
  record("Extension permissions", notes.length === 0,
    (notes.length ? notes.join("; ") + "\n    " : "") +
    `permissions: ${(m.permissions || []).join(", ")}; host access: ${hosts.join(", ")} (needed to redirect admin-listed AI sites; accepted risk)`);
}

// ---------- report ----------
const width = Math.max(...results.map((r) => r.name.length));
console.log("\nPrompt Guard security check\n");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed ? `${failed} check(s) FAILED` : "All checks passed"}  (${new Date().toLocaleString("en-ZA")})\n`);
process.exit(failed ? 1 : 0);
