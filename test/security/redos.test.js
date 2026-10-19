// Adversarial inputs must not make detection slow (ReDoS). A crafted paste
// would freeze the chat page; crafted events would tie up the collector.
const test = require("node:test");
const assert = require("node:assert/strict");
const { detect } = require("../../extension/src/detectors.js");

const N = 100000; // 100 KB, easy to paste
const CASES = {
  "email-dots": "a@" + "a.".repeat(N / 2) + "!",
  "email-local": "a".repeat(N) + "@",
  "email-domain": "a@" + "a".repeat(N),
  digits: "1".repeat(N),
  "digits-spaced": "1 ".repeat(N / 2),
  "digits-dash": "1-".repeat(N / 2) + "x",
  words: "thabo ".repeat(N / 6),
  caps: "Abc ".repeat(N / 4),
  particles: "van ".repeat(N / 4) + "x",
  "particles-cue": "Mr de ".repeat(N / 6),
  address: "12 " + "abc ".repeat(N / 4) + "zz",
  context: "card number " + "x".repeat(N),
  "context-num": ("card " + "1 ").repeat(N / 7),
  dob: "born " + "1/1/".repeat(N / 4),
  ip: "1.".repeat(N / 2),
  secret: "password=" + "a".repeat(N),
  pem: "-----BEGIN PRIVATE KEY-----" + "a".repeat(N),
  jwt: "eyJ" + "a".repeat(N) + ".eyJ" + "a".repeat(N),
  keyword: "project ".repeat(N / 8),
};

for (const [name, text] of Object.entries(CASES)) {
  test(`ReDoS: ${name} (${Math.round(text.length / 1000)} KB) scans in < 300 ms`, () => {
    const t0 = process.hrtime.bigint();
    detect(text, { keywords: ["Project Falcon"], people: { names: ["Nomsa Kwetana"] } });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 300, `${name} took ${ms.toFixed(0)} ms`);
  });
}
