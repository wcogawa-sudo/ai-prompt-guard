const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { detect, luhnValid } = require(path.join(__dirname, "../extension/src/detectors.js"));
const P = require(path.join(__dirname, "../extension/src/policy.js"));
const shippedPolicy = require(path.join(__dirname, "../extension/policy.default.json"));
// Most tests check per-rule behaviour, so they use the policy with the global
// warning switch unset; the switch has its own tests below.
const defaultPolicy = structuredClone(shippedPolicy);
delete defaultPolicy.warning.enabled;

const types = (text, opts) => detect(text, opts).map((d) => d.type);

// Build a Luhn-valid SA ID from the first 12 digits.
function makeId(first12) {
  for (let c = 0; c <= 9; c++) if (luhnValid(first12 + c)) return first12 + c;
}

test("SA ID: valid numbers detected, contiguous and spaced", () => {
  const id = makeId("800101500908");
  assert.deepEqual(types(`client id ${id} please`), ["SA_ID_NUMBER"]);
  const spaced = `${id.slice(0, 6)} ${id.slice(6, 10)} ${id.slice(10)}`;
  assert.deepEqual(types(`id: ${spaced}`), ["SA_ID_NUMBER"]);
});

test("SA ID: invalid 13-digit numbers are still flagged, as lower-confidence 'possible' IDs", () => {
  const id = makeId("800101500908");
  const conf = (t) => detect(t)[0];
  const badLuhn = id.slice(0, 12) + ((+id[12] + 1) % 10);
  assert.equal(conf(badLuhn).type, "SA_ID_NUMBER");
  assert.equal(conf(badLuhn).possible, true);
  assert.ok(conf(badLuhn).confidence < 0.99);
  assert.equal(conf(makeId("801301500908")).confidence, 0.6); // month 13: weakest
  assert.equal(conf(id).confidence, 0.99);
  assert.equal(conf(id).possible, false);
});

test("SA ID: not matched inside a longer digit run (that's a long number instead)", () => {
  const id = makeId("800101500908");
  assert.deepEqual(types("9" + id + "9"), ["LONG_NUMBER"]);
});

test("Credit card: Luhn-valid cards detected, random digits not", () => {
  assert.deepEqual(types("card 4111 1111 1111 1111 exp 12/29"), ["CREDIT_CARD"]);
  assert.deepEqual(types("card 5555-5555-5555-4444"), ["CREDIT_CARD"]);
  const bad = detect("ref 4111 1111 1111 1112"); // fails Luhn but card-shaped
  assert.equal(bad[0].type, "CREDIT_CARD");
  assert.equal(bad[0].possible, true);
});

test("Overlap: valid SA ID that is also Luhn-valid wins as SA_ID", () => {
  // Starts with 4 (Visa prefix), 13 digits, Luhn-valid, valid date.
  const id = makeId("400101500908");
  assert.deepEqual(types(id), ["SA_ID_NUMBER"]);
});

test("Email and SA phone numbers", () => {
  assert.deepEqual(types("mail thabo.nkosi@example.co.za"), ["EMAIL"]);
  for (const ph of ["082 123 4567", "0821234567", "+27 82 123 4567", "+27 (0)82-123-4567", "011 555 1234"]) {
    assert.deepEqual(types(`call ${ph} now`), ["PHONE_NUMBER"], ph);
  }
  assert.deepEqual(types("order 1234567"), []);
});

test("Secrets: known key formats and password assignments", () => {
  assert.deepEqual(types("key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123"), ["API_SECRET"]);
  assert.deepEqual(types("AKIAABCDEFGHIJKLMNOP"), ["API_SECRET"]);
  assert.deepEqual(types("ghp_" + "a".repeat(36)), ["API_SECRET"]);
  const d = detect('db password = "Sup3rS3cret!"');
  assert.equal(d.length, 1);
  assert.equal(d[0].value, "Sup3rS3cret!");
  assert.deepEqual(types("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----"), ["API_SECRET"]);
});

test("Keywords: case-insensitive whole-word match", () => {
  const opts = { keywords: ["Project Falcon"] };
  assert.deepEqual(types("status of project falcon?", opts), ["KEYWORD"]);
  assert.deepEqual(types("project falconry", opts), []);
});

test("Policy: strictest action wins; warn types reported", () => {
  const id = makeId("800101500908");
  const text = `ID ${id}, email a@b.co.za`;
  const dec = P.evaluate(detect(text), defaultPolicy, {});
  assert.equal(dec.action, "redact_warn");
  assert.deepEqual(dec.warnTypes, ["SA_ID_NUMBER"]);
});

test("Policy: card is redacted silently (org rule) and raises SOC alert", () => {
  const dec = P.evaluate(detect("4111111111111111"), defaultPolicy, {});
  assert.equal(dec.action, "redact_silent");
  assert.equal(dec.alertSoc, true);
});

test("Policy: API keys are redacted (not blocked) and raise a SOC alert; orgs can still choose block", () => {
  const dec = P.evaluate(detect("AKIAABCDEFGHIJKLMNOP"), defaultPolicy, {});
  assert.equal(dec.action, "redact_silent");
  assert.equal(dec.alertSoc, true);
  const strict = structuredClone(defaultPolicy);
  strict.rules.find((r) => r.type === "API_SECRET").action = "block";
  assert.equal(P.evaluate(detect("AKIAABCDEFGHIJKLMNOP"), strict, {}).action, "block");
});

test("Policy: bulk counts only strong identifiers, not names", () => {
  const names = "Thabo Nkosi, Sipho Dlamini, Lerato Mokoena, Johan Botha, Priya Naidoo, Ayanda Zulu, " +
    "Karabo Molefe, Thandi Khumalo, Pieter Steyn, Zanele Mthembu, Kagiso Ndlovu";
  const dec = P.evaluate(detect(names), defaultPolicy, {});
  assert.equal(dec.bulk, false);
  assert.equal(dec.action, "redact_silent");
});

test("Policy: group override and snooze downgrade warnings", () => {
  const id = makeId("800101500908");
  const dets = detect(id);
  assert.equal(P.evaluate(dets, defaultPolicy, { group: "Finance" }).action, "redact_silent");
  assert.equal(P.evaluate(dets, defaultPolicy, { snoozedTypes: new Set(["SA_ID_NUMBER"]) }).action, "redact_silent");
});

test("Policy: bulk paste of IDs is redacted with a warning and a SOC alert (not blocked)", () => {
  const ids = Array.from({ length: 10 }, (_, i) => makeId(`8001${String(i + 1).padStart(2, "0")}500908`));
  const dec = P.evaluate(detect(ids.join("\n")), defaultPolicy, {});
  assert.equal(dec.bulk, true);
  assert.equal(dec.action, "redact_warn");
  assert.equal(dec.alertSoc, true);
});

test("Policy: min_confidence filters weak detections", () => {
  const policy = { rules: [{ type: "PHONE_NUMBER", action: "block", min_confidence: 0.9 }] };
  assert.equal(P.evaluate(detect("082 123 4567"), policy, {}).action, "allow");
});

test("Redaction: consistent placeholders, send vs log text", () => {
  const id = makeId("800101500908");
  const text = `${id} emailed a@b.co.za about ${id}`;
  const dec = P.evaluate(detect(text), defaultPolicy, {});
  const ph = new P.Placeholders();
  assert.equal(P.textToSend(text, dec, ph), "[SA_ID_NUMBER_1] emailed [EMAIL_1] about [SA_ID_NUMBER_1]");

  // log_only items are left in the sent text but redacted in the log.
  const policy = { rules: [{ type: "EMAIL", action: "log_only" }] };
  const dec2 = P.evaluate(detect("mail a@b.co.za"), policy, {});
  const ph2 = new P.Placeholders();
  assert.equal(P.textToSend("mail a@b.co.za", dec2, ph2), "mail a@b.co.za");
  assert.equal(P.textToLog("mail a@b.co.za", dec2, ph2), "mail [EMAIL_1]");
});

test("Redaction: placeholders stay stable across prompts in a conversation", () => {
  const ph = new P.Placeholders();
  const policy = { rules: [{ type: "EMAIL", action: "redact_silent" }] };
  const t1 = "a@b.co.za and c@d.co.za";
  const t2 = "reply to c@d.co.za";
  P.textToSend(t1, P.evaluate(detect(t1), policy, {}), ph);
  assert.equal(P.textToSend(t2, P.evaluate(detect(t2), policy, {}), ph), "reply to [EMAIL_2]");
});

test("Placeholders don't trigger detectors on rescan", () => {
  assert.deepEqual(types("[SA_ID_NUMBER_1] [EMAIL_1] [CREDIT_CARD_1] [PHONE_NUMBER_1]"), []);
});

// ---------- loose / context detectors ----------

const first = (t) => detect(t).map((d) => `${d.type}:${d.value}`);

test("Context: user says what the number is, whatever its format", () => {
  assert.deepEqual(first("here is my credit card number 557388210"), ["CREDIT_CARD:557388210"]);
  assert.deepEqual(first("here is my card 12345678901234"), ["CREDIT_CARD:12345678901234"]);
  assert.deepEqual(first("is this an id number? 12345678890"), ["SA_ID_NUMBER:12345678890"]);
  assert.deepEqual(first("my tax number is 0123456789"), ["TAX_NUMBER:0123456789"]);
  assert.deepEqual(first("passport A12345678"), ["PASSPORT:A12345678"]);
  assert.deepEqual(first("acc no 62012345678"), ["BANK_ACCOUNT:62012345678"]);
  assert.deepEqual(first("medical aid number 12345678"), ["MEMBER_NUMBER:12345678"]);
});

test("Long standalone numbers are flagged as possible references", () => {
  assert.deepEqual(first("80121210213912931"), ["LONG_NUMBER:80121210213912931"]);
  assert.deepEqual(first("order 12345"), []); // short numbers are fine
});

test("Names: dictionary pairs work in lowercase; cues and titles", () => {
  assert.deepEqual(first("who is clement rogers"), ["PERSON_NAME:clement rogers"]);
  assert.deepEqual(first("thabo mokena"), ["PERSON_NAME:thabo mokena"]);
  assert.deepEqual(first("Johan van der Merwe called"), ["PERSON_NAME:Johan van der Merwe"]);
  assert.deepEqual(first("Mr Botha is late"), ["PERSON_NAME:Botha"]);
  assert.deepEqual(first("My name is Kwezi Langeni"), ["PERSON_NAME:Kwezi Langeni"]); // unknown names, cue
});

test("Names: known first name + unfamiliar next word is a surname (any case)", () => {
  assert.deepEqual(first("please ask priya nkemelu"), ["PERSON_NAME:priya nkemelu"]);
  assert.deepEqual(first("William Okafor sent it"), ["PERSON_NAME:William Okafor"]);
  assert.deepEqual(first("WILLIAM OKAFOR"), ["PERSON_NAME:WILLIAM OKAFOR"]);
  assert.deepEqual(first("Will Okafor sent it"), ["PERSON_NAME:Will Okafor"]); // ambiguous: both capitalised
  assert.deepEqual(first("my name is will okafor"), ["PERSON_NAME:will okafor"]); // ambiguous: cue
  // familiar words, slang, acronyms and code stay out of the name
  assert.deepEqual(first("ask john tmrw"), ["PERSON_NAME:john"]);
  assert.deepEqual(first("john running late"), ["PERSON_NAME:john"]);
  assert.deepEqual(first("send to john AWS keys"), ["PERSON_NAME:john"]);
  assert.deepEqual(first("john useState hook"), ["PERSON_NAME:john"]);
  assert.deepEqual(first("I will kubectl apply it"), []);
  assert.deepEqual(first("Will you send it"), []);
});

test("Names: everyday words are not names", () => {
  assert.deepEqual(first("We will meet in May with Grace and Hope"), []);
  assert.deepEqual(first("Invoice total R1500 for 3 items in April"), []);
  assert.deepEqual(first("Please review the report and send it to the team"), []);
});

test("Addresses, dates of birth, IPs", () => {
  assert.deepEqual(first("I live at 12 Main Road, Rondebosch, 7700"), ["ADDRESS:12 Main Road, Rondebosch, 7700"]);
  assert.deepEqual(first("PO Box 1234, Pretoria, 0001"), ["ADDRESS:PO Box 1234, Pretoria, 0001"]);
  assert.deepEqual(first("DOB 1985-03-14"), ["DATE_OF_BIRTH:1985-03-14"]);
  assert.deepEqual(first("born on 14 March 1985"), ["DATE_OF_BIRTH:14 March 1985"]);
  assert.deepEqual(first("server 10.10.10.50 ok"), ["IP_ADDRESS:10.10.10.50"]);
  assert.deepEqual(first("version 1.2.3"), []);
  assert.deepEqual(first("Server is on 10.20.30.40."), ["IP_ADDRESS:10.20.30.40"]);
  assert.deepEqual(first("build 1.2.3.4.5"), []);
});

test("Secrets: our own placeholders are never re-detected (collector re-scrub)", () => {
  assert.deepEqual(first("db password: [API_SECRET_4]"), []);
  assert.deepEqual(first("db password: Summer2026!Acme"), ["API_SECRET:Summer2026!Acme"]);
});

test("Confirmed detections beat guesses on the same text", () => {
  const id = makeId("800101500908");
  assert.deepEqual(first(`id number ${id}`), [`SA_ID_NUMBER:${id}`]);
  assert.equal(detect(`id number ${id}`)[0].confidence, 0.99);
  assert.deepEqual(first("call me on 082 123 4567"), ["PHONE_NUMBER:082 123 4567"]);
});

test("Warning switch: shipped default is ON (every redaction is confirmed)", () => {
  assert.equal(shippedPolicy.warning.enabled, true);
  const dec = P.evaluate(detect("mail a@b.co.za for thabo mokena"), shippedPolicy, {});
  assert.equal(dec.action, "redact_warn");
  assert.deepEqual(dec.warnTypes.sort(), ["EMAIL", "PERSON_NAME"]);
});

test("Warning switch: OFF makes every redaction silent; blocks still block", () => {
  const off = structuredClone(shippedPolicy);
  off.warning.enabled = false;
  const id = makeId("800101500908");
  assert.equal(P.evaluate(detect(`client ${id}`), off, {}).action, "redact_silent");
  off.rules.find((r) => r.type === "API_SECRET").action = "block"; // an org that chose blocking
  assert.equal(P.evaluate(detect("AKIAABCDEFGHIJKLMNOP"), off, {}).action, "block");
});

test("Warning switch: snooze still silences a type while ON", () => {
  const dec = P.evaluate(detect("mail a@b.co.za"), shippedPolicy, { snoozedTypes: new Set(["EMAIL"]) });
  assert.equal(dec.action, "redact_silent");
});

test("Names: surname particles (lowercase, unknown names, after titles)", () => {
  assert.deepEqual(first("how much does george de lange make"), ["PERSON_NAME:george de lange"]);
  assert.deepEqual(first("Mr de Lange approved it"), ["PERSON_NAME:de Lange"]);
  assert.deepEqual(first("ask Ms van Wyk"), ["PERSON_NAME:van Wyk"]);
  assert.deepEqual(first("the delivery van driver is late"), []);
  assert.deepEqual(first("we rented a van for the move"), []);
  assert.deepEqual(first("de facto standard"), []);
});

test("Names: org people list is always caught, any case/spacing", () => {
  const people = { names: ["Nomsa Kwetana"], first_names: ["Kwezi"], last_names: ["Langeni"] };
  const f = (t) => detect(t, { people }).map((d) => `${d.type}:${d.value}`);
  assert.deepEqual(f("email nomsa kwetana today"), ["PERSON_NAME:nomsa kwetana"]);
  assert.deepEqual(f("NOMSA  KWETANA said no"), ["PERSON_NAME:NOMSA  KWETANA"]);
  assert.deepEqual(f("kwezi langeni called"), ["PERSON_NAME:kwezi langeni"]);
  assert.equal(detect("email nomsa kwetana today", { people })[0].confidence, 1);
});

// ---------- admin dashboard ----------

const admin = require(path.join(__dirname, "../collector/admin.js"));

test("Admin summary: prompts, violations by outcome, categories, sites, previous-period delta", () => {
  const now = Date.parse("2026-10-07T12:00:00");
  const at = (daysAgo, h) => new Date(now - daysAgo * 86400000 - (h || 0) * 3600000).toISOString();
  const ev = (daysAgo, action, extra) => ({ "@timestamp": at(daysAgo), "event.action": action, "ai.site": "chatgpt.com",
    "user.name": "u1", "browser.user_agent": "Mozilla/5.0 Chrome/152.0 Safari/537.36", ...extra });
  const events = [
    ev(0, "prompt_sent"),
    ev(1, "prompt_sent_redacted", { "user.decision": "accepted", detections: [{ type: "SA_ID_NUMBER", count: 1 }] }),
    ev(1, "prompt_sent_redacted", { "user.decision": "silent", detections: [{ type: "EMAIL", count: 1 }] }),
    ev(2, "prompt_blocked", { detections: [{ type: "API_SECRET", count: 1 }], "alert.soc": true }),
    ev(2, "paste_cancelled", { detections: [{ type: "KEYWORD", count: 1 }] }),
    ev(3, "file_blocked", { "ai.site": "claude.ai" }),
    ev(3, "prompt_sent_unredacted", { detections: [{ type: "SA_ID_NUMBER", count: 1 }] }),
    ev(10, "prompt_sent"), // previous period
    ev(10, "prompt_blocked", { detections: [{ type: "API_SECRET", count: 1 }] }),
  ];
  const s = admin.summarize(events, { days: 7, now });
  assert.equal(s.totals.prompts, 5); // sent, 2 redacted, blocked, unredacted (paste/file aren't sends)
  assert.equal(s.totals.violations, 6);
  assert.deepEqual(s.outcomes, { redacted: 1, warned: 1, cancelled: 1, blocked: 2, override: 1 });
  assert.deepEqual(s.categories, { "Sensitive data": 3, Secrets: 1, "Confidential terms": 1, Files: 1 });
  assert.equal(s.totals.promptsPrev, 2);
  assert.equal(s.totals.promptsDeltaPct, 150);
  assert.equal(s.daily.length, 7);
  assert.equal(s.daily.reduce((n, d) => n + d.prompts, 0), 5);
  assert.deepEqual(s.browsers, { "Chrome / Chromium": 5 });
  assert.equal(s.sites[0].site, "chatgpt.com");
  assert.equal(admin.summarize(events, { days: 7, now, site: "claude.ai" }).totals.violations, 1);
});

test("Admin recent(): newest first, limited, within the date range, no raw extras", () => {
  const now = Date.parse("2026-10-07T12:00:00");
  const events = [
    { "@timestamp": new Date(now - 20 * 86400000).toISOString(), "event.action": "prompt_sent" },
    { "@timestamp": new Date(now - 3600000).toISOString(), "event.action": "prompt_sent", "browser.user_agent": "x" },
    { "@timestamp": new Date(now - 60000).toISOString(), "event.action": "prompt_blocked" },
  ];
  const r = admin.recent(events, { days: 7, now, limit: 10 });
  assert.deepEqual(r.map((e) => e["event.action"]), ["prompt_blocked", "prompt_sent"]);
  assert.equal(r[1]["browser.user_agent"], undefined);
});

test("Admin drill(): filters by outcome, day, category, site, kind; ranks users", () => {
  const now = Date.parse("2026-10-07T12:00:00");
  const t = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString();
  const ev = (daysAgo, user, action, extra) => ({ "@timestamp": t(daysAgo), "user.name": user, "ai.site": "chatgpt.com", "event.action": action, ...extra });
  const events = [
    ev(0, "ann", "prompt_sent_redacted", { "user.decision": "accepted", detections: [{ type: "PERSON_NAME", count: 1 }] }),
    ev(0, "ann", "prompt_sent_redacted", { "user.decision": "accepted", detections: [{ type: "EMAIL", count: 1 }] }),
    ev(0, "bob", "prompt_sent_redacted", { "user.decision": "accepted", detections: [{ type: "EMAIL", count: 1 }] }),
    ev(0, "bob", "prompt_sent_redacted", { "user.decision": "silent", detections: [{ type: "EMAIL", count: 1 }] }),
    ev(1, "cat", "prompt_blocked", { detections: [{ type: "API_SECRET", count: 1 }], "alert.soc": true, "ai.site": "claude.ai" }),
    ev(1, "cat", "prompt_sent"),
  ];
  const day0 = new Date(now); const k = `${day0.getFullYear()}-${String(day0.getMonth() + 1).padStart(2, "0")}-${String(day0.getDate()).padStart(2, "0")}`;
  const warned = admin.drill(events, { now, days: 7, outcome: "warned", day: k });
  assert.equal(warned.total, 3);
  assert.deepEqual(warned.users.map((u) => [u.user, u.count]), [["ann", 2], ["bob", 1]]);
  assert.equal(admin.drill(events, { now, days: 7, category: "Secrets" }).users[0].user, "cat");
  assert.equal(admin.drill(events, { now, days: 7, kind: "prompts" }).total, 6);
  assert.equal(admin.drill(events, { now, days: 7, kind: "attention" }).total, 1);
  assert.equal(admin.drill(events, { now, days: 7, kind: "all", site: "claude.ai" }).total, 1);
  assert.equal(admin.drill(events, { now, days: 7, outcome: "warned", user: "bob" }).total, 1);
});

// ---------- network safety net (netscan) ----------
const NS = require(path.join(__dirname, "../extension/src/netscan.js"));
function netScan(body, extra) {
  const ph = new P.Placeholders();
  const ruleAction = (d) => {
    const dec = P.evaluate([d], defaultPolicy, {});
    return dec.items.length ? dec.items[0].action : "allow";
  };
  return NS.scan(body, { detect, tokenFor: (t, v) => ph.tokenFor(t, v), ruleAction, ...extra });
}

test("netscan: confirmed ID and card in a JSON body are replaced in the raw text", () => {
  const id = makeId("800101500908");
  const body = `{"model":"x","messages":[{"content":"client ${id} card 4111 1111 1111 1111"}],"big":12345678901234567890}`;
  const r = netScan(body);
  assert.equal(r.verified, true);
  assert.deepEqual(r.enforce.map((h) => h.type).sort(), ["CREDIT_CARD", "SA_ID_NUMBER"]);
  assert.equal(r.body, `{"model":"x","messages":[{"content":"client [SA_ID_NUMBER_1] card [CREDIT_CARD_1]"}],"big":12345678901234567890}`);
});

test("netscan: timestamps, uuids, possible IDs and emails are left alone", () => {
  const body = JSON.stringify({ ts: "1791381142023", id: "3f2a9c1e-7b4d-4e8a-9f00-1234567890ab", near: "8001015009088", mail: "a@b.co" });
  const r = netScan(body);
  assert.equal(r.hits.length, 0);
  assert.equal(r.body, body);
});

test("netscan: escaped JSON text (newlines/quotes) is still found and replaced", () => {
  const id = makeId("850615500908");
  const body = JSON.stringify({ text: `line one\n"quoted" ${id}\ttab` });
  const r = netScan(body);
  assert.equal(r.verified, true);
  assert.ok(!r.body.includes(id));
  assert.equal(JSON.parse(r.body).text, `line one\n"quoted" [SA_ID_NUMBER_1]\ttab`);
});

test("netscan: plain-text and form bodies work too", () => {
  const id = makeId("800101500908");
  assert.equal(netScan(`q=${id}&x=1`).body, "q=[SA_ID_NUMBER_1]&x=1");
});

test("netscan: values the user chose to send unredacted are allowed through", () => {
  const id = makeId("800101500908");
  const r = netScan(`{"t":"${id}"}`, { allowValues: new Set(["SA_ID_NUMBER\u0000" + id]) });
  assert.equal(r.enforce.length, 0);
});

test("netscan: an admin 'allow' or 'log_only' rule is respected", () => {
  const id = makeId("800101500908");
  const pol = structuredClone(defaultPolicy);
  pol.rules.find((x) => x.type === "SA_ID_NUMBER").action = "log_only";
  const ph = new P.Placeholders();
  const r = NS.scan(`{"t":"${id}"}`, { detect, tokenFor: (t, v) => ph.tokenFor(t, v),
    ruleAction: (d) => P.evaluate([d], pol, {}).items[0].action });
  assert.equal(r.hits.length, 1);
  assert.equal(r.enforce.length, 0);
  assert.equal(r.body, `{"t":"${id}"}`);
});

test("netscan: an API secret is caught; huge bodies are skipped", () => {
  const r = netScan(JSON.stringify({ t: "use key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD" }));
  assert.ok(r.enforce.some((h) => h.type === "API_SECRET"), JSON.stringify(r.hits));
  assert.equal(netScan("x".repeat(NS.MAX_BODY + 1)).scanned, false);
});

test("netscan: a value that can't be replaced fails verification (caller blocks)", () => {
  const id = makeId("800101500908");
  // \u escapes: the raw text doesn't contain the plain value, so it can't be swapped.
  const escaped = id.split("").map((c) => "\\u00" + c.charCodeAt(0).toString(16)).join("");
  const r = netScan(`{"t":"${escaped}"}`);
  assert.equal(r.enforce.length, 1);
  assert.equal(r.verified, false);
});
