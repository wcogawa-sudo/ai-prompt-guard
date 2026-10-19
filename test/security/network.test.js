// Security tests for the network safety net (page-net.js + netscan.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "../../extension/src");
const { detect } = require(path.join(SRC, "detectors.js"));
const NS = require(path.join(SRC, "netscan.js"));
const { Placeholders } = require(path.join(SRC, "policy.js"));

test("page-world script never touches extension APIs, policy or detectors", () => {
  // page-net.js runs in the AI site's own JavaScript world. Nothing private
  // (policy, people list, detectors, chrome.* APIs) may be loaded there.
  const code = fs.readFileSync(path.join(SRC, "page-net.js"), "utf8").replace(/\/\/.*$/gm, "");
  for (const bad of [/\bchrome\./, /\bbrowser\./, /\bPG\b/, /policy/i, /people/i, /detect/i, /localStorage/, /postMessage/]) {
    assert.doesNotMatch(code, bad, `page-net.js must not reference ${bad}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, "../manifest.json"), "utf8"));
  const main = manifest.content_scripts.filter((c) => c.world === "MAIN").flatMap((c) => c.js);
  assert.deepEqual(main.sort(), ["src/page-files.js", "src/page-net.js"], "only the two page-world shims run in MAIN");
});

test("netscan: adversarial 1 MB bodies finish quickly (no ReDoS)", () => {
  const ph = new Placeholders();
  const opts = { detect, tokenFor: (t, v) => ph.tokenFor(t, v) };
  const bodies = [
    JSON.stringify({ t: "1".repeat(NS.MAX_BODY - 20) }),
    JSON.stringify({ t: "4111 ".repeat(Math.floor((NS.MAX_BODY - 20) / 5)) }),
    JSON.stringify(Array.from({ length: 4000 }, (_, i) => ({ k: "x".repeat(200) + i }))),
    "a=" + "%41".repeat(300000),
  ];
  for (const b of bodies) {
    const t0 = Date.now();
    NS.scan(b, opts);
    assert.ok(Date.now() - t0 < 3000, `scan took ${Date.now() - t0} ms on a ${b.length}-char body`);
  }
});

test("netscan: malformed or hostile input never throws", () => {
  const ph = new Placeholders();
  const opts = { detect, tokenFor: (t, v) => ph.tokenFor(t, v) };
  for (const b of ['{"a":', "[[[[[[", '{"__proto__":{"x":1}}', "\u0000￿", null, 42, "", '{"t":"\\ud800"}']) {
    assert.doesNotThrow(() => NS.scan(b, opts));
  }
  // __proto__ in a body must not pollute anything.
  NS.scan('{"__proto__":{"polluted":true},"t":"8001015009087"}', opts);
  assert.equal({}.polluted, undefined);
});

test("netscan: deep nesting doesn't blow the stack", () => {
  const ph = new Placeholders();
  const deep = "[".repeat(5000) + "]".repeat(5000);
  assert.doesNotThrow(() => NS.scan(deep, { detect, tokenFor: (t, v) => ph.tokenFor(t, v) }));
});
