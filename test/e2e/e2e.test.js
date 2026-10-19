// End-to-end: real Chromium + the extension + mock ChatGPT/Claude pages built
// on real ProseMirror + the real collector. Run via `npm run test:e2e`.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const puppeteer = require("puppeteer-core");
const { luhnValid } = require("../../extension/src/detectors.js");

const EXT = path.join(__dirname, ".tmp", "ext");
const FIXTURES = path.join(__dirname, "fixtures");
const TMP = path.join(__dirname, ".tmp");
const LOG_FILE = path.join(TMP, "events.ndjson");
const EVIDENCE_FILE = path.join(TMP, "evidence.ndjson"); // collector default: next to the log
const TOKEN = "e2e-test-token";
const CHROME = process.env.CHROME_PATH || "/usr/bin/chromium";

function makeId(first12) {
  for (let c = 0; c <= 9; c++) if (luhnValid(first12 + c)) return first12 + c;
}
const ID1 = makeId("800101500908");
const ID2 = makeId("850615500908");
const CARD = "4111 1111 1111 1111";

let server, port, collector, collectorPort, browser;
const posted = []; // POST bodies the fixture server received

function startFixtureServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      // Record what actually leaves the browser (network safety-net tests).
      if (req.method === "POST") {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => { posted.push({ path: req.url, body }); res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); });
        return;
      }
      const file = path.join(FIXTURES, path.basename(req.url.split("?")[0]) || "chatgpt.html");
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : "text/html" });
      fs.createReadStream(file).pipe(res);
    }).listen(0, "127.0.0.1", () => { port = server.address().port; resolve(); });
  });
}

function startCollector() {
  collectorPort = 18787 + Math.floor(Math.random() * 1000);
  fs.rmSync(LOG_FILE, { force: true });
  fs.rmSync(EVIDENCE_FILE, { force: true });
  collector = spawn(process.execPath, [path.join(__dirname, "../../collector/server.js")], {
    env: { ...process.env, PG_TOKEN: TOKEN, PG_PORT: String(collectorPort), PG_OUT: LOG_FILE, PG_ADMIN_PASSWORD: "e2e-admin" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    collector.stdout.on("data", (d) => { if (String(d).includes("collector on")) resolve(); });
    collector.stderr.on("data", (d) => process.stderr.write("[collector] " + d));
    collector.on("exit", (c) => reject(new Error("collector exited " + c)));
  });
}

// Run code with extension privileges via the options page (puppeteer's
// service-worker eval context doesn't expose chrome.storage).
let extPage;
async function extEval(fn, ...args) {
  if (!extPage || extPage.isClosed()) {
    extPage = await browser.newPage();
    await extPage.goto(`chrome-extension://${EXT_ID}/options.html`);
  }
  return extPage.evaluate(fn, ...args);
}

async function setOptions(options) {
  await extEval(async (o) => {
    await chrome.storage.local.set({ options: o, snoozes: {} });
  }, options);
  // background reloads config on options change and republishes `effective`
  await new Promise((r) => setTimeout(r, 500));
}

const BASE_OPTIONS = () => ({
  collectorUrl: `http://127.0.0.1:${collectorPort}`,
  collectorToken: TOKEN,
  userName: "e2e-user",
  deviceId: "LT-E2E",
});

async function openSite(name) {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${port}/${name}.html`, { waitUntil: "load" });
  await page.waitForSelector(".ProseMirror");
  await new Promise((r) => setTimeout(r, 150)); // content script config load
  return page;
}

async function typeInto(page, text) {
  await page.click(".ProseMirror");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i) await page.keyboard.down("Shift"), await page.keyboard.press("Enter"), await page.keyboard.up("Shift");
    await page.keyboard.type(lines[i]);
  }
}

const sent = (page) => page.evaluate(() => window.__sent);
const editorText = (page) => page.evaluate(() => window.__promptText());
const dialogOpen = (page) => page.evaluate(() => !!document.querySelector("prompt-guard-ui"));

// Our UI can show several hosts at once (e.g. a "Protected" toast plus a dialog);
// these helpers always use the one that contains a dialog.
async function clickDialog(page, selector) {
  await page.waitForFunction(() => [...document.querySelectorAll("prompt-guard-ui")]
    .some((h) => h.shadowRoot && h.shadowRoot.querySelector(".dialog")), { timeout: 3000 });
  await page.evaluate((sel) => {
    const host = [...document.querySelectorAll("prompt-guard-ui")].find((h) => h.shadowRoot && h.shadowRoot.querySelector(".dialog"));
    [...host.shadowRoot.querySelectorAll(sel.split("|")[0])]
      .find((b) => !sel.includes("|") || b.textContent.includes(sel.split("|")[1])).click();
  }, selector);
}
const dialogText = (page) => page.evaluate(() => {
  const host = [...document.querySelectorAll("prompt-guard-ui")].find((h) => h.shadowRoot && h.shadowRoot.querySelector(".dialog"));
  return host ? host.shadowRoot.querySelector(".dialog").textContent : "";
});

async function waitSent(page, n) {
  await page.waitForFunction((k) => window.__sent.length >= k, { timeout: 4000 }, n);
  return sent(page);
}

async function pasteText(page, text) {
  await page.click(".ProseMirror");
  // Trusted paste: put text on the (headless) clipboard and run the paste command.
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  const cdp = await page.createCDPSession();
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "v", code: "KeyV", modifiers: 2, commands: ["paste"] });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "v", code: "KeyV", modifiers: 2 });
  await cdp.detach();
}

async function flushAndReadLogs() {
  // Ask the background worker to upload its queue, via an extension page.
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${EXT_ID}/options.html`);
  await new Promise((r) => setTimeout(r, 300)); // let queued log writes settle
  await page.evaluate(() => chrome.runtime.sendMessage({ type: "flushNow" }));
  await page.close();
  await new Promise((r) => setTimeout(r, 300));
  if (!fs.existsSync(LOG_FILE)) return [];
  return fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

let EXT_ID;

test.before(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  await startFixtureServer();
  await startCollector();
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    pipe: true,
    enableExtensions: [EXT],
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const target = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/src/background.js"), { timeout: 10000 });
  EXT_ID = new URL(target.url()).host;
  const ctx = browser.defaultBrowserContext();
  await ctx.overridePermissions(`http://localhost:${port}`, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
  await setOptions(BASE_OPTIONS());
});

// Reset settings after every test so one failure can't leak into the next.
test.afterEach(async () => {
  if (browser && EXT_ID) await setOptions(BASE_OPTIONS());
});

test.after(async () => {
  if (browser) await browser.close();
  if (collector) collector.kill();
  if (server) server.close();
});

test("extension ID is stable (matches key in manifest)", () => {
  const expected = fs.readFileSync(path.join(__dirname, "../../keys/extension-id.txt"), "utf8").trim();
  assert.equal(EXT_ID, expected);
});

test("clean prompt is sent unchanged, no dialog (Enter)", async () => {
  const page = await openSite("chatgpt");
  await typeInto(page, "Summarise the benefits of MFA");
  await page.keyboard.press("Enter");
  const s = await waitSent(page, 1);
  assert.equal(s[0].text, "Summarise the benefits of MFA");
  assert.equal(await dialogOpen(page), false);
  await page.close();
});

test("email is silently redacted (send button click)", async () => {
  const page = await openSite("chatgpt");
  await typeInto(page, "Draft a reply to thabo@example.co.za about the invoice");
  await page.click("#send");
  const s = await waitSent(page, 1);
  assert.equal(s[0].text, "Draft a reply to [EMAIL_1] about the invoice");
  await page.close();
});

test("SA ID: warning shown, accept sends redacted", async () => {
  const page = await openSite("chatgpt");
  await typeInto(page, `Check client ${ID1} for FICA`);
  await page.keyboard.press("Enter");
  await clickDialog(page, "button.primary");
  const s = await waitSent(page, 1);
  assert.equal(s[0].text, "Check client [SA_ID_NUMBER_1] for FICA");
  assert.ok(!s[0].text.includes(ID1));
  await page.close();
});

test("SA ID: warning text describes the data and previews placeholder", async () => {
  const page = await openSite("chatgpt");
  await typeInto(page, `IDs ${ID1} and ${ID2}`);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("prompt-guard-ui"));
  const txt = await dialogText(page);
  assert.match(txt, /2 SA ID numbers/);
  assert.match(txt, /\[SA_ID_NUMBER_1\] and \[SA_ID_NUMBER_2\]/);
  assert.ok(!txt.includes(ID1), "raw ID must not appear in dialog");
  await clickDialog(page, "button|Cancel");
  await page.close();
});

test("SA ID: cancel sends nothing and keeps the original text for editing", async () => {
  const page = await openSite("chatgpt");
  await typeInto(page, `Client ${ID1}`);
  await page.keyboard.press("Enter");
  await clickDialog(page, "button|Cancel");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await sent(page)).length, 0);
  assert.equal(await editorText(page), `Client ${ID1}`);
  await page.close();
});

test("card number is redacted silently (org policy) and still sent", async () => {
  const page = await openSite("chatgpt");
  await typeInto(page, `Refund card ${CARD}`);
  await page.click("#send");
  const s = await waitSent(page, 1);
  assert.equal(s[0].text, "Refund card [CREDIT_CARD_1]");
  await page.close();
});

test("loose rules on a real editor: names, context numbers, long numbers", async () => {
  const page = await openSite("chatgpt");
  await typeInto(page, "who is clement rogers");
  await page.keyboard.press("Enter");
  await waitSent(page, 1);
  await typeInto(page, "here is my credit card number 557388210");
  await page.keyboard.press("Enter");
  await waitSent(page, 2);
  await typeInto(page, "ref 80121210213912931 for thabo mokena");
  await page.keyboard.press("Enter");
  const s = await waitSent(page, 3).catch(async (e) => {
    console.log("DEBUG sent:", JSON.stringify(await sent(page)), "editor:", JSON.stringify(await editorText(page)));
    throw e;
  });
  assert.equal(s[0].text, "who is [PERSON_NAME_1]");
  assert.equal(s[1].text, "here is my credit card number [CREDIT_CARD_1]");
  assert.equal(s[2].text, "ref [LONG_NUMBER_1] for [PERSON_NAME_2]");
  await page.close();
});

test("loose rules: a 'possible' ID (bad checksum) still warns", async () => {
  const page = await openSite("chatgpt");
  await typeInto(page, "is this an id number? 12345678890");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("prompt-guard-ui"));
  assert.match(await dialogText(page), /1 SA ID number/);
  await clickDialog(page, "button.primary");
  const s = await waitSent(page, 1);
  assert.equal(s[0].text, "is this an id number? [SA_ID_NUMBER_1]");
  await page.close();
});

// Orgs can still choose to block; these tests check blocking works when they do.
async function useBlockingPolicy() {
  const policy = JSON.parse(fs.readFileSync(path.join(EXT, "policy.default.json"), "utf8"));
  policy.rules.find((r) => r.type === "API_SECRET").action = "block";
  policy.bulk_threshold.action = "block";
  await setOptions({ ...BASE_OPTIONS(), policyJson: JSON.stringify(policy) });
}

test("API key (default): redacted and still sent, so the developer gets an answer", async () => {
  const page = await openSite("chatgpt");
  await typeInto(page, "why does AKIAABCDEFGHIJKLMNOP fail");
  await page.keyboard.press("Enter");
  const s = await waitSent(page, 1);
  assert.equal(s[0].text, "why does [API_SECRET_1] fail");
  await page.close();
});

test("bulk paste (default): warning, then all values redacted (not blocked)", async () => {
  const page = await openSite("chatgpt");
  const ids = Array.from({ length: 12 }, (_, i) => makeId(`8001${String(i + 1).padStart(2, "0")}500908`));
  await pasteText(page, ids.join("\n"));
  await page.waitForFunction(() => [...document.querySelectorAll("prompt-guard-ui")].some((h) => h.shadowRoot.querySelector(".dialog")));
  assert.match(await dialogText(page), /12 SA ID numbers/);
  await clickDialog(page, "button.primary");
  await page.waitForFunction(() => window.__promptText().includes("[SA_ID_NUMBER_12]"));
  assert.ok(!(await editorText(page)).includes(ids[0]));
  await page.close();
});

test("API key is blocked (org chose block)", async () => {
  await useBlockingPolicy();
  const page = await openSite("chatgpt");
  await typeInto(page, "why does AKIAABCDEFGHIJKLMNOP fail");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("prompt-guard-ui"));
  assert.match(await dialogText(page), /password \/ API key/);
  await clickDialog(page, "button.primary");
  assert.equal((await sent(page)).length, 0);
  await page.close();
});

test("multi-line prompt keeps its lines after redaction", async () => {
  const page = await openSite("chatgpt");
  await typeInto(page, `Line one\nemail jo@example.com\nLine three`);
  await page.keyboard.press("Enter");
  const s = await waitSent(page, 1);
  assert.equal(s[0].text, "Line one\nemail [EMAIL_1]\nLine three");
  await page.close();
});

test("placeholders stay consistent across prompts in one conversation", async () => {
  const page = await openSite("chatgpt");
  await typeInto(page, "a@x.co.za and b@x.co.za");
  await page.keyboard.press("Enter");
  await waitSent(page, 1);
  await typeInto(page, "now only b@x.co.za");
  await page.keyboard.press("Enter");
  const s = await waitSent(page, 2);
  assert.equal(s[1].text, "now only [EMAIL_2]");
  await page.close();
});

test("paste with SA ID: warning at paste time, accept inserts redacted text", async () => {
  const page = await openSite("chatgpt");
  await pasteText(page, `pasted ${ID1}`);
  await clickDialog(page, "button.primary");
  await page.waitForFunction(() => window.__promptText().includes("[SA_ID"));
  assert.equal(await editorText(page), "pasted [SA_ID_NUMBER_1]");
  await page.close();
});

test("paste of several API keys + password into Claude: none reach the box", async () => {
  const page = await openSite("claude");
  const creds = [
    "OPENAI_API_KEY=sk-proj-Ab3dEf9GhIjK2LmNoPqRsT5uVwXyZ0aB1cD4eF7gH8iJ",
    "ANTHROPIC_API_KEY=sk-ant-api03-Zx8Yw7Vu6Ts5Rq4Po3Nm2Lk1Ji0HgFeDcBa9876543210abcdEFGH",
    "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
    "db password: Summer2026!Acme",
    "Passport for Thandi: A12345678, DOB 12/03/1985. Server is on 10.20.30.40.",
  ].join("\n");
  await pasteText(page, creds);
  await clickDialog(page, "button.primary");
  await page.waitForFunction(() => window.__promptText().includes("[API_SECRET"));
  await new Promise((r) => setTimeout(r, 300));
  const box = await editorText(page);
  for (const raw of ["sk-proj-", "sk-ant-", "AKIAIOSFODNN7EXAMPLE", "Summer2026", "A12345678"]) assert.ok(!box.includes(raw), `${raw} reached the box`);
  await page.close();
});

test("large paste that the site turns into an attachment is redacted first", async () => {
  const page = await openSite("chatgpt");
  const big = "x ".repeat(1200) + `customer ${ID1} end`;
  await pasteText(page, big);
  await clickDialog(page, "button.primary");
  await page.waitForFunction(() => window.__attachments.length === 1);
  const att = await page.evaluate(() => window.__attachments[0]);
  assert.ok(att.includes("[SA_ID_NUMBER_1]"));
  assert.ok(!att.includes(ID1));
  await page.close();
});

test("paste with an API key is blocked when the org chose block", async () => {
  await useBlockingPolicy();
  const page = await openSite("chatgpt");
  await pasteText(page, "key AKIAABCDEFGHIJKLMNOP");
  await clickDialog(page, "button.primary");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await editorText(page), "");
  await page.close();
});

test("Enter in an unrelated textarea is not intercepted", async () => {
  const page = await openSite("chatgpt");
  await page.click("#settings");
  await page.keyboard.type(`my id ${ID1}`);
  await page.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await dialogOpen(page), false);
  assert.equal((await sent(page)).length, 0);
  await page.close();
});

test("Claude-style page: warning + accept works with its send button", async () => {
  const page = await openSite("claude");
  await typeInto(page, `Client ${ID1} wants a summary`);
  await page.click('button[aria-label="Send message"]');
  await clickDialog(page, "button.primary");
  const s = await waitSent(page, 1);
  assert.equal(s[0].text, "Client [SA_ID_NUMBER_1] wants a summary");
  await page.close();
});

test("snooze: after 'don't warn again', IDs are redacted silently", async () => {
  const page = await openSite("chatgpt");
  await typeInto(page, `first ${ID1}`);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("prompt-guard-ui"));
  await page.evaluate(() => document.querySelector("prompt-guard-ui").shadowRoot.querySelector('input[type="checkbox"]').click());
  await clickDialog(page, "button.primary");
  await waitSent(page, 1);
  await new Promise((r) => setTimeout(r, 200));
  await typeInto(page, `second ${ID2}`);
  await page.keyboard.press("Enter");
  const s = await waitSent(page, 2);
  assert.equal(s[1].text, "second [SA_ID_NUMBER_2]");
  await extEval(() => chrome.storage.local.set({ snoozes: {} }));
  await page.close();
});

test("policy override via options: Finance group gets silent ID redaction", async () => {
  await setOptions({ ...BASE_OPTIONS(), group: "Finance" });
  const page = await openSite("chatgpt");
  await typeInto(page, `payroll for ${ID1}`);
  await page.keyboard.press("Enter");
  const s = await waitSent(page, 1);
  assert.equal(s[0].text, "payroll for [SA_ID_NUMBER_1]");
  await page.close();
  await setOptions(BASE_OPTIONS());
});

test("bulk paste is blocked as a data dump when the org chose block", async () => {
  await useBlockingPolicy();
  const page = await openSite("chatgpt");
  const ids = Array.from({ length: 12 }, (_, i) => makeId(`8001${String(i + 1).padStart(2, "0")}500908`));
  await pasteText(page, ids.join("\n"));
  await page.waitForFunction(() => document.querySelector("prompt-guard-ui"));
  assert.match(await dialogText(page), /data export/);
  await clickDialog(page, "button.primary");
  assert.equal(await editorText(page), "");
  await page.close();
});

test("unapproved AI site redirects to the blocked page", async () => {
  const policy = JSON.parse(fs.readFileSync(path.join(EXT, "policy.default.json"), "utf8"));
  policy.sites.unapproved.push("blocked-ai.test");
  await setOptions({ ...BASE_OPTIONS(), policyJson: JSON.stringify(policy) });
  const page = await browser.newPage();
  await page.goto("http://blocked-ai.test/some/path?q=1").catch(() => {});
  await page.waitForFunction(() => location.href.includes("blocked.html"), { timeout: 4000 });
  assert.equal(new URL(page.url()).searchParams.get("site"), "blocked-ai.test");
  await page.waitForSelector("#go:not([hidden])");
  assert.equal(await page.$eval("#go", (a) => a.href), "https://claude.ai/");
  await page.close();
  await setOptions(BASE_OPTIONS());
});

test("override (when admin enables it): justification required, original sent, logged", async () => {
  const policy = JSON.parse(fs.readFileSync(path.join(EXT, "policy.default.json"), "utf8"));
  policy.override_unredacted.enabled = true;
  await setOptions({ ...BASE_OPTIONS(), policyJson: JSON.stringify(policy) });
  const page = await openSite("chatgpt");
  await typeInto(page, `verify ${ID2} with Home Affairs`);
  await page.keyboard.press("Enter");
  await clickDialog(page, "button|Send original instead");
  // Too-short justification is refused
  await clickDialog(page, "button|Send original");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await sent(page)).length, 0);
  await page.evaluate(() => {
    const ta = document.querySelector("prompt-guard-ui").shadowRoot.querySelector("textarea");
    ta.value = "Manager-approved Home Affairs verification for client 0821234567";
  });
  await clickDialog(page, "button|Send original");
  const s = await waitSent(page, 1);
  assert.equal(s[0].text, `verify ${ID2} with Home Affairs`);
  // The network safety net respects the user's override for that value.
  await page.evaluate((id) => fetch("/api/net-override", { method: "POST", body: JSON.stringify({ t: `verify ${id}` }) }), ID2);
  const [got] = await waitPosted("/api/net-override");
  assert.equal(JSON.parse(got.body).t, `verify ${ID2}`);
  await page.close();
  await setOptions(BASE_OPTIONS());
});

test("override is not offered when policy has it disabled (default)", async () => {
  const page = await openSite("chatgpt");
  await typeInto(page, `check ${ID1}`);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("prompt-guard-ui"));
  assert.ok(!(await dialogText(page)).includes("Send original"));
  await clickDialog(page, "button|Cancel");
  await page.close();
});

test("false-positive report is logged and data is still redacted", async () => {
  const page = await openSite("chatgpt");
  await typeInto(page, `ref ${ID1}`);
  await page.keyboard.press("Enter");
  await clickDialog(page, "button|false positive");
  assert.match(await dialogText(page), /reported to your admin/);
  await clickDialog(page, "button.primary");
  const s = await waitSent(page, 1);
  assert.equal(s[0].text, "ref [SA_ID_NUMBER_1]");
  await page.close();
});

test("collector down (still at work): events queue locally and upload once it's reachable", async () => {
  // "At work" is decided by a separate work-network probe that's still reachable.
  const policy = JSON.parse(fs.readFileSync(path.join(EXT, "policy.default.json"), "utf8"));
  policy.scope.probe_url = `http://localhost:${port}/chatgpt.html`;
  await setOptions({ ...BASE_OPTIONS(), collectorUrl: "http://127.0.0.1:9", policyJson: JSON.stringify(policy) });
  const page = await openSite("chatgpt");
  await typeInto(page, "queued while offline");
  await page.keyboard.press("Enter");
  await waitSent(page, 1);
  await page.close();
  await new Promise((r) => setTimeout(r, 500));
  const before = await extEval(() => chrome.runtime.sendMessage({ type: "status" }));
  assert.ok(before.queued >= 1, "event should be queued");
  assert.equal(before.lastFlush.ok, false);
  await setOptions(BASE_OPTIONS());
  await extEval(() => chrome.runtime.sendMessage({ type: "flushNow" }));
  const after = await extEval(() => chrome.runtime.sendMessage({ type: "status" }));
  assert.equal(after.queued, 0);
  const raw = fs.readFileSync(LOG_FILE, "utf8");
  assert.ok(raw.includes("queued while offline"));
});

// ---------- edit-message bypass (and other text boxes) ----------

async function typeEdit(page, text) {
  await page.click("#edit-box");
  await page.$eval("#edit-box", (x) => x.select());
  await page.keyboard.press("Backspace");
  await page.keyboard.type(text);
}

test("edit message (ChatGPT-style): Send button can't bypass redaction", async () => {
  const page = await openSite("chatgpt");
  await typeEdit(page, `actually client ${ID1}`);
  await page.click("#edit-send");
  await clickDialog(page, "button.primary");
  const s = await waitSent(page, 1);
  assert.equal(s[0].edited, true);
  assert.equal(s[0].text, "actually client [SA_ID_NUMBER_1]");
  await page.close();
});

test("edit message: Enter in the edit box can't bypass redaction", async () => {
  const page = await openSite("chatgpt");
  await typeEdit(page, "send it to thabo@example.co.za");
  await page.keyboard.press("Enter");
  const s = await waitSent(page, 1);
  assert.equal(s[0].text, "send it to [EMAIL_1]");
  await page.close();
});

test("edit message (Claude-style Save button): card is redacted, API key blocked (org chose block)", async () => {
  await useBlockingPolicy();
  const page = await openSite("claude");
  await typeEdit(page, `use card ${CARD}`);
  await page.click("#edit-save");
  const s = await waitSent(page, 1);
  assert.equal(s[0].text, "use card [CREDIT_CARD_1]");
  await typeEdit(page, "key AKIAABCDEFGHIJKLMNOP");
  await page.click("#edit-save");
  await page.waitForFunction(() => [...document.querySelectorAll("prompt-guard-ui")].some((h) => h.shadowRoot.querySelector(".dialog")));
  assert.match(await dialogText(page), /Not sent/);
  await clickDialog(page, "button.primary");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await sent(page)).length, 1, "blocked edit was not saved");
  await page.close();
});

test("edit message: Cancel button is never intercepted", async () => {
  const page = await openSite("chatgpt");
  await typeEdit(page, `client ${ID1}`);
  await page.click("#edit-cancel");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await dialogOpen(page), false);
  await page.close();
});

test("edit message: paste into the edit box is checked too", async () => {
  const page = await openSite("chatgpt");
  await page.click("#edit-box");
  await page.$eval("#edit-box", (x) => x.select());
  await page.keyboard.press("Backspace");
  await page.evaluate((t) => navigator.clipboard.writeText(t), `pasted ${ID1}`);
  const cdp = await page.createCDPSession();
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "v", code: "KeyV", modifiers: 2, commands: ["paste"] });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "v", code: "KeyV", modifiers: 2 });
  await cdp.detach();
  await clickDialog(page, "button.primary");
  await page.waitForFunction(() => document.getElementById("edit-box").value.includes("[SA_ID"));
  assert.equal(await page.$eval("#edit-box", (x) => x.value), `pasted [SA_ID_NUMBER_1]`);
  await page.close();
});

// ---------- logged-out ChatGPT layout: React-controlled <textarea> ----------

async function openLoggedOut() {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${port}/chatgpt-loggedout.html`, { waitUntil: "load" });
  await page.waitForSelector('textarea[name="prompt"]');
  await new Promise((r) => setTimeout(r, 150));
  return page;
}

async function typeTextarea(page, text) {
  await page.click('textarea[name="prompt"]');
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i) { await page.keyboard.down("Shift"); await page.keyboard.press("Enter"); await page.keyboard.up("Shift"); }
    await page.keyboard.type(lines[i]);
  }
}

test("logged-out ChatGPT (React textarea): clean prompt sent unchanged", async () => {
  const page = await openLoggedOut();
  await typeTextarea(page, "What is phishing?");
  await page.keyboard.press("Enter");
  const s = await waitSent(page, 1);
  assert.equal(s[0].text, "What is phishing?");
  await page.close();
});

test("logged-out ChatGPT: accepted warning sends the REDACTED text from React state", async () => {
  const page = await openLoggedOut();
  await typeTextarea(page, `Check client ${ID1} for FICA`);
  await page.keyboard.press("Enter");
  await clickDialog(page, "button.primary");
  const s = await waitSent(page, 1);
  assert.equal(s[0].text, "Check client [SA_ID_NUMBER_1] for FICA");
  assert.ok(!s[0].text.includes(ID1), "React state must hold the redacted text, not the original");
  await page.close();
});

test("logged-out ChatGPT: send button click path", async () => {
  const page = await openLoggedOut();
  await typeTextarea(page, "mail thabo@example.co.za");
  await page.click('button[aria-label="Send message"]');
  const s = await waitSent(page, 1);
  assert.equal(s[0].text, "mail [EMAIL_1]");
  await page.close();
});

test("logged-out ChatGPT: cancel keeps original, nothing sent", async () => {
  const page = await openLoggedOut();
  await typeTextarea(page, `Client ${ID1}`);
  await page.keyboard.press("Enter");
  await clickDialog(page, "button|Cancel");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await sent(page)).length, 0);
  assert.equal(await editorText(page), `Client ${ID1}`);
  await page.close();
});

test("logged-out ChatGPT: API key blocked (org chose block)", async () => {
  await useBlockingPolicy();
  const page = await openLoggedOut();
  await typeTextarea(page, "key AKIAABCDEFGHIJKLMNOP please");
  await page.keyboard.press("Enter");
  await clickDialog(page, "button.primary");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await sent(page)).length, 0);
  await page.close();
});

test("logged-out ChatGPT: paste with ID is redacted in React state before sending", async () => {
  const page = await openLoggedOut();
  await typeTextarea(page, "before ");
  await page.click('textarea[name="prompt"]');
  await page.evaluate((t) => navigator.clipboard.writeText(t), `${ID1} after`);
  const cdp = await page.createCDPSession();
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "v", code: "KeyV", modifiers: 2, commands: ["paste"] });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "v", code: "KeyV", modifiers: 2 });
  await cdp.detach();
  await clickDialog(page, "button.primary");
  await page.waitForFunction(() => window.__promptText().includes("[SA_ID"));
  await page.keyboard.press("Enter");
  const s = await waitSent(page, 1);
  assert.equal(s[0].text, "before [SA_ID_NUMBER_1] after");
  await page.close();
});

test("logged-out ChatGPT: multi-line textarea keeps lines", async () => {
  const page = await openLoggedOut();
  await typeTextarea(page, "one\nmail jo@example.com\nthree");
  await page.keyboard.press("Enter");
  const s = await waitSent(page, 1);
  assert.equal(s[0].text, "one\nmail [EMAIL_1]\nthree");
  await page.close();
});

// ---------- work-only scope ----------

async function scopeNow() {
  return extEval(() => chrome.runtime.sendMessage({ type: "checkScope" }));
}

test("scope: off the work network the extension is dormant (no warning, no redaction, no log)", async () => {
  // At home: the collector (default work-network probe) can't be reached.
  await setOptions({ ...BASE_OPTIONS(), collectorUrl: "http://127.0.0.1:9" });
  const st = await scopeNow();
  assert.equal(st.active, false);
  assert.match(st.reason, /not reachable/);
  const page = await openSite("chatgpt");
  await typeInto(page, `home use ${ID1} card ${CARD}`);
  await page.keyboard.press("Enter");
  const s = await waitSent(page, 1);
  assert.equal(s[0].text, `home use ${ID1} card ${CARD}`, "untouched outside work");
  assert.equal(await dialogOpen(page), false);
  await page.close();
  const status = await extEval(() => chrome.runtime.sendMessage({ type: "status" }));
  const queued = await extEval(() => chrome.storage.local.get("queue").then((r) => JSON.stringify(r.queue || [])));
  assert.ok(!queued.includes("home use"), "nothing logged outside work");
  assert.equal(status.scope.active, false);
});

test("scope: no unapproved-site redirect outside work", async () => {
  const policy = JSON.parse(fs.readFileSync(path.join(EXT, "policy.default.json"), "utf8"));
  policy.sites.unapproved.push("blocked-ai.test");
  await setOptions({ ...BASE_OPTIONS(), collectorUrl: "http://127.0.0.1:9", policyJson: JSON.stringify(policy) });
  assert.equal((await scopeNow()).active, false);
  const page = await browser.newPage();
  await page.goto("http://blocked-ai.test/").catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(!page.url().includes("blocked.html"), "not redirected at home");
  await page.close();
});

test("scope: back on the work network it re-activates", async () => {
  await setOptions(BASE_OPTIONS());
  assert.equal((await scopeNow()).active, true);
  const page = await openSite("chatgpt");
  await typeInto(page, "mail back@example.com");
  await page.keyboard.press("Enter");
  const s = await waitSent(page, 1);
  assert.equal(s[0].text, "mail [EMAIL_1]");
  await page.close();
});

test("scope: work-hours mode is dormant outside the configured hours", async () => {
  const policy = JSON.parse(fs.readFileSync(path.join(EXT, "policy.default.json"), "utf8"));
  policy.scope = { mode: "work_hours", hours: { days: [], start: "00:00", end: "23:59" } }; // no work days
  await setOptions({ ...BASE_OPTIONS(), policyJson: JSON.stringify(policy) });
  const st = await scopeNow();
  assert.equal(st.active, false);
  assert.match(st.reason, /outside work hours/);
  policy.scope.hours.days = [0, 1, 2, 3, 4, 5, 6];
  await setOptions({ ...BASE_OPTIONS(), policyJson: JSON.stringify(policy) });
  assert.equal((await scopeNow()).active, true);
});

// ---------- file uploads ----------

async function withFilePolicy(action, extra) {
  const policy = JSON.parse(fs.readFileSync(path.join(EXT, "policy.default.json"), "utf8"));
  policy.files = { action, alert_soc: action === "block" };
  Object.assign(policy, extra || {});
  await setOptions({ ...BASE_OPTIONS(), ...(extra && extra.__group ? { group: extra.__group } : {}), policyJson: JSON.stringify(policy) });
}

const SAMPLE = path.join(TMP, "Thabo_8001015009087_payslip.txt");
async function pickViaAttach(page, ms) {
  fs.writeFileSync(SAMPLE, "sample");
  const chooser = page.waitForFileChooser({ timeout: ms || 1500 }).catch(() => null);
  await page.click("#attach");
  const c = await chooser;
  if (c) await c.accept([SAMPLE]);
  await new Promise((r) => setTimeout(r, 300));
  return !!c;
}
const filesSeen = (page) => page.evaluate(() => window.__files);

test("files allowed (default): attach button works normally", async () => {
  const page = await openSite("chatgpt");
  assert.equal(await pickViaAttach(page), true);
  assert.deepEqual(await filesSeen(page), [path.basename(SAMPLE)]);
  await page.close();
});

test("files blocked: attach button never opens the picker (site-code input.click())", async () => {
  await withFilePolicy("block");
  const page = await openSite("chatgpt");
  assert.equal(await pickViaAttach(page), false, "picker must not open");
  assert.deepEqual(await filesSeen(page), []);
  assert.match(await dialogText(page), /File uploads are turned off/);
  await clickDialog(page, "button.primary");
  await page.close();
});

test("files blocked: visible file input can't be used either", async () => {
  await withFilePolicy("block");
  const page = await openSite("chatgpt");
  const chooser = page.waitForFileChooser({ timeout: 1500 }).catch(() => null);
  await page.click("#visible-file");
  assert.equal(await chooser, null);
  await page.close();
});

test("files blocked: drag-and-drop is stopped", async () => {
  await withFilePolicy("block");
  const page = await openSite("chatgpt");
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "secret.pdf", { type: "application/pdf" }));
    document.querySelector(".ProseMirror").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(await filesSeen(page), []);
  await page.close();
});

test("files blocked: pasted screenshot is stopped, but the text pasted with it still goes in", async () => {
  await withFilePolicy("block");
  const page = await openSite("chatgpt");
  await page.click(".ProseMirror");
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["png"], "screenshot.png", { type: "image/png" }));
    dt.setData("text/plain", "table text");
    document.querySelector(".ProseMirror").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(await filesSeen(page) || [], []);
  assert.equal(await editorText(page), "table text");
  await page.close();
});

test("files: a group override can allow uploads for one team", async () => {
  const policy = JSON.parse(fs.readFileSync(path.join(EXT, "policy.default.json"), "utf8"));
  policy.files = { action: "block" };
  policy.groups.Design = { FILE_UPLOAD: "allow" };
  await setOptions({ ...BASE_OPTIONS(), group: "Design", policyJson: JSON.stringify(policy) });
  const page = await openSite("chatgpt");
  assert.equal(await pickViaAttach(page), true);
  await page.close();
});

test("files log_only: upload allowed and logged with the file name redacted", async () => {
  await withFilePolicy("log_only");
  const page = await openSite("chatgpt");
  assert.equal(await pickViaAttach(page), true);
  assert.deepEqual(await filesSeen(page), [path.basename(SAMPLE)]);
  await page.close();
});

test("files blocked: never applies outside work", async () => {
  const policy = JSON.parse(fs.readFileSync(path.join(EXT, "policy.default.json"), "utf8"));
  policy.files = { action: "block" };
  await setOptions({ ...BASE_OPTIONS(), collectorUrl: "http://127.0.0.1:9", policyJson: JSON.stringify(policy) });
  assert.equal((await scopeNow()).active, false);
  const page = await openSite("chatgpt");
  assert.equal(await pickViaAttach(page), true, "at home the picker works normally");
  await page.close();
});

test("org people list: boss's name redacted even though it's in no dictionary", async () => {
  const policy = JSON.parse(fs.readFileSync(path.join(EXT, "policy.default.json"), "utf8"));
  policy.people = { names: ["Nomsa Kwetana"] };
  await setOptions({ ...BASE_OPTIONS(), policyJson: JSON.stringify(policy) });
  const page = await openSite("chatgpt");
  await typeInto(page, "how much does nomsa kwetana make");
  await page.keyboard.press("Enter");
  const s = await waitSent(page, 1);
  assert.equal(s[0].text, "how much does [PERSON_NAME_1] make");
  await page.close();
});

test("options 'names to always protect' box works", async () => {
  await setOptions({ ...BASE_OPTIONS(), peopleNames: "Zukisa Mabandla\n" });
  const page = await openSite("chatgpt");
  await typeInto(page, "is zukisa mabandla in today");
  await page.keyboard.press("Enter");
  const s = await waitSent(page, 1);
  assert.equal(s[0].text, "is [PERSON_NAME_1] in today");
  await page.close();
});

test("particle surnames on a real editor: 'george de lange'", async () => {
  const page = await openSite("chatgpt");
  await typeInto(page, "how much does george de lange make");
  await page.keyboard.press("Enter");
  const s = await waitSent(page, 1);
  assert.equal(s[0].text, "how much does [PERSON_NAME_1] make");
  await page.close();
});

// ---------- warnings on/off switch ----------

test("warnings ON (options checkbox): even a normally-silent email shows the warning", async () => {
  await setOptions({ ...BASE_OPTIONS(), warningsEnabled: true });
  const page = await openSite("chatgpt");
  await typeInto(page, "reply to thabo@example.co.za");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("prompt-guard-ui"));
  assert.match(await dialogText(page), /1 email address/);
  await clickDialog(page, "button.primary");
  const s = await waitSent(page, 1);
  assert.equal(s[0].text, "reply to [EMAIL_1]");
  await page.close();
});

test("warnings OFF: an SA ID is redacted silently, no pop-up", async () => {
  await setOptions({ ...BASE_OPTIONS(), warningsEnabled: false });
  const page = await openSite("chatgpt");
  await typeInto(page, `client ${ID1}`);
  await page.keyboard.press("Enter");
  const s = await waitSent(page, 1);
  assert.equal(s[0].text, "client [SA_ID_NUMBER_1]");
  await page.close();
});

test("options page: warnings checkbox reflects and saves the setting", async () => {
  await setOptions({ ...BASE_OPTIONS(), warningsEnabled: false });
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${EXT_ID}/options.html`);
  await page.waitForFunction(() => document.querySelector("#status dd"));
  assert.equal(await page.$eval("#warningsEnabled", (c) => c.checked), false);
  await page.click("#warningsEnabled");
  await page.click("#save");
  await new Promise((r) => setTimeout(r, 800));
  const st = await page.evaluate(() => chrome.runtime.sendMessage({ type: "status" }));
  assert.equal(st.warningsEnabled, true);
  await page.close();
});

test("logs reach the collector, redacted, with user and decisions", async () => {
  const events = await flushAndReadLogs();
  assert.ok(events.length >= 10, `expected many events, got ${events.length}`);
  const raw = fs.readFileSync(LOG_FILE, "utf8");
  for (const secret of [ID1, ID2, "4111 1111 1111 1111", "thabo@example.co.za", "AKIAABCDEFGHIJKLMNOP"]) {
    assert.ok(!raw.includes(secret), `raw value leaked into logs: ${secret}`);
  }
  const actions = new Set(events.map((e) => e["event.action"]));
  for (const a of ["prompt_sent", "prompt_sent_redacted", "prompt_cancelled", "prompt_blocked", "paste_redacted", "paste_blocked"]) {
    assert.ok(actions.has(a), `missing event.action ${a}`);
  }
  const accepted = events.find((e) => e["event.action"] === "prompt_sent_redacted" && e["user.decision"] === "accepted");
  assert.ok(accepted);
  assert.equal(accepted["user.name"], "e2e-user");
  assert.equal(accepted["host.name"], "LT-E2E");
  assert.ok(accepted["prompt.redacted"].includes("[SA_ID_NUMBER_1]"));
  const blocked = events.find((e) => e["event.action"] === "prompt_blocked");
  assert.equal(blocked["alert.soc"], true);
  assert.ok(events.some((e) => e.bulk === true));
  const ov = events.find((e) => e["event.action"] === "prompt_sent_unredacted");
  assert.ok(ov, "override event logged");
  assert.equal(ov["alert.soc"], true);
  assert.match(ov["override.justification"], /Manager-approved/);
  assert.ok(!ov["override.justification"].includes("0821234567"), "justification is redacted too");
  assert.ok(events.some((e) => e["event.action"] === "false_positive_report"));
  const loggedOut = events.filter((e) => e["tab.url_host"] === "localhost" && (e["prompt.redacted"] || "").startsWith("What is phishing"));
  assert.ok(loggedOut.length && loggedOut.every((e) => e["ai.adapter_degraded"] === false), "logged-out layout recognised, not degraded");
  const fb = events.find((e) => e["event.action"] === "file_blocked" && e["file.method"] === "drop");
  assert.ok(fb, "file_blocked logged");
  assert.deepEqual(fb["file.extensions"], ["pdf"]);
  const fa = events.find((e) => e["event.action"] === "file_attached");
  assert.ok(fa, "file_attached logged in log_only mode");
  assert.ok(!JSON.stringify(fa).includes("8001015009087"), "ID in file name is redacted");
  assert.match(fa["file.names_redacted"][0], /\[SA_ID_NUMBER_1\]/);
  assert.ok(events.some((e) => e.stage === "edit" && e["event.action"] === "prompt_sent_redacted"), "edit-stage events logged");
  // Evidence store is off by default: nothing stored.
  assert.ok(!events.some((e) => e["evidence.id"] || e.evidence), "no evidence when disabled");
  assert.equal(fs.existsSync(EVIDENCE_FILE), false);
});

test("collector rejects requests without the token", async () => {
  const res = await fetch(`http://127.0.0.1:${collectorPort}/events`, { method: "POST", body: "[]" });
  assert.equal(res.status, 401);
});

test("collector re-scrubs raw PII that slips into a log event", async () => {
  const res = await fetch(`http://127.0.0.1:${collectorPort}/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify([{ "event.action": "test", "prompt.redacted": `leak ${ID1}` }]),
  });
  assert.equal(res.status, 200);
  const last = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").pop();
  const ev = JSON.parse(last);
  assert.equal(ev["prompt.redacted"], "leak [SA_ID_NUMBER_1]");
  assert.equal(ev["collector.rescrubbed"], true);
});

test("evidence: browser encrypts the original, collector can't read it, investigator can", async () => {
  const key = path.join(TMP, "evidence-private.key");
  fs.rmSync(key, { force: true });
  fs.rmSync(key.replace(/\.key$/, ".public.json"), { force: true });
  const env = { ...process.env, PG_EVIDENCE_PASSPHRASE: "e2e passphrase 123" };
  const cli = path.join(__dirname, "../../scripts/evidence.js");
  const { execFileSync, spawnSync } = require("node:child_process");
  execFileSync(process.execPath, [cli, "keygen", "--out", key], { env });
  const pub = JSON.parse(fs.readFileSync(key.replace(/\.key$/, ".public.json"), "utf8"));

  // Enabled the easy way: the keygen output pasted into the options box.
  await setOptions({ ...BASE_OPTIONS(), evidenceConfig: JSON.stringify({ evidence: { enabled: true, ...pub } }) });

  const page = await openSite("chatgpt");
  await typeInto(page, `Evidence test client ${ID2} email z@example.com`);
  await page.keyboard.press("Enter");
  await clickDialog(page, "button.primary");
  await waitSent(page, 1);
  await page.close();
  const events = await flushAndReadLogs();

  const ev = events.filter((e) => e["evidence.id"]).pop();
  assert.ok(ev, "event points at its evidence");
  assert.equal(ev["evidence.present"], true);
  assert.equal(ev.evidence, undefined, "ciphertext is not in the normal log");
  assert.equal(ev["prompt.redacted"], "Evidence test client [SA_ID_NUMBER_1] email [EMAIL_1]");

  const evidenceRaw = fs.readFileSync(EVIDENCE_FILE, "utf8");
  assert.ok(!evidenceRaw.includes(ID2) && !evidenceRaw.includes("z@example.com"), "evidence store holds only ciphertext");
  assert.ok(evidenceRaw.includes(ev["evidence.id"]));
  // the queue in browser storage must never hold plain text either
  const queued = await extEval(() => chrome.storage.local.get(null).then((all) => JSON.stringify(all)));
  assert.ok(!queued.includes(ID2), "no plain text in extension storage");

  const audit = path.join(TMP, "evidence-access.log");
  fs.rmSync(audit, { force: true });
  const out = spawnSync(process.execPath, [cli, "view", ev["evidence.id"], "--key", key, "--evidence", EVIDENCE_FILE,
    "--audit", audit, "--analyst", "e2e", "--reason", "E2E evidence round trip"], { env, encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, new RegExp(`Evidence test client ${ID2} email z@example.com`));
  assert.match(out.stdout, /\[EMAIL_1\]\s+EMAIL\s+z@example.com/);
  assert.equal(fs.readFileSync(audit, "utf8").trim().split("\n").length, 1);
});

test("evidence: misconfigured key never falls back to plain text", async () => {
  const policy = JSON.parse(fs.readFileSync(path.join(EXT, "policy.default.json"), "utf8"));
  policy.evidence = { enabled: true, public_key_spki: "not-a-real-key", key_id: "" };
  await setOptions({ ...BASE_OPTIONS(), policyJson: JSON.stringify(policy) });
  const page = await openSite("chatgpt");
  await typeInto(page, `bad key test ${ID1}`);
  await page.keyboard.press("Enter");
  await clickDialog(page, "button.primary");
  await waitSent(page, 1);
  await page.close();
  const events = await flushAndReadLogs();
  const ev = events.filter((e) => (e["prompt.redacted"] || "").startsWith("bad key test")).pop();
  assert.ok(ev["evidence.error"], "error recorded");
  assert.equal(ev["evidence.id"], undefined);
  assert.ok(!fs.readFileSync(EVIDENCE_FILE, "utf8").includes(ID1));
  assert.ok(!fs.readFileSync(LOG_FILE, "utf8").includes(ID1));
});

// ---------- admin dashboard ----------

test("admin dashboard: login required; wrong password refused", async () => {
  const base = `http://127.0.0.1:${collectorPort}`;
  assert.equal((await fetch(`${base}/admin`)).status, 401);
  const bad = Buffer.from("admin:wrong").toString("base64");
  assert.equal((await fetch(`${base}/admin/api/summary`, { headers: { Authorization: `Basic ${bad}` } })).status, 401);
});

test("admin dashboard: executive and analyst views render real data with no errors", async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.authenticate({ username: "admin", password: "e2e-admin" });
  await page.goto(`http://127.0.0.1:${collectorPort}/admin`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.getElementById("exec-summary").textContent.length > 20);
  const summary = await page.$eval("#exec-summary", (x) => x.textContent);
  assert.match(summary, /staff sent \d+ prompts? to/);
  assert.ok(+(await page.$eval("#hero-value", (x) => x.textContent)) > 0, "leaks prevented > 0 after the test run");
  assert.ok(await page.$("#exec-chart svg path[tabindex]"), "chart has bars");
  // Exec view never shows prompt text
  assert.ok(!(await page.$eval("#view-exec", (x) => x.textContent)).includes("[SA_ID_NUMBER_1]"));
  await page.click("#tab-analyst");
  await page.waitForFunction(() => document.querySelectorAll("#an-feed tbody tr").length > 0);
  const feed = await page.$eval("#an-feed", (x) => x.textContent);
  assert.ok(feed.includes("e2e-user"));
  assert.ok(!feed.includes(ID1), "feed shows redacted prompts only");
  assert.match(await page.$eval("#an-chain", (x) => x.textContent), /intact/);
  await page.click('[data-table="an-violations"]');
  assert.ok(await page.$("#an-violations table"), "table view available");
  assert.deepEqual(errors, []);
  await page.close();
});

test("admin dashboard: clicking a bar segment shows who and the prompts behind it", async () => {
  const page = await browser.newPage();
  await page.authenticate({ username: "admin", password: "e2e-admin" });
  await page.goto(`http://127.0.0.1:${collectorPort}/admin`, { waitUntil: "networkidle0" });
  await page.waitForSelector("#exec-chart svg path.clickable");
  const label = await page.$eval("#exec-chart svg path.clickable", (x) => x.getAttribute("aria-label"));
  await page.click("#exec-chart svg path.clickable");
  await page.waitForFunction(() => document.querySelectorAll("#drill-users tbody tr").length > 0);
  assert.equal(await page.$eval("#drill-title", (x) => x.textContent.split(" · ")[0]), label.split(",")[0]);
  assert.match(await page.$eval("#drill-users", (x) => x.textContent), /e2e-user/);
  const evText = await page.$eval("#drill-events", (x) => x.textContent);
  assert.ok(!evText.includes(ID1), "drill-down shows redacted prompts only");
  // narrowing to one user from the Who table
  await page.click("#drill-users .user-link");
  await page.waitForFunction(() => document.getElementById("drill-title").textContent.includes("e2e-user"));
  await page.keyboard.press("Escape");
  assert.equal(await page.$eval("#drill", (d) => d.hidden), true);
  // keyboard: legend item opens the panel with Enter
  await page.focus("#exec-legend button");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.getElementById("drill").hidden);
  await page.close();
});

test("admin dashboard: unlock with the private key, show/hide the original, every view audited", async () => {
  const key = path.join(TMP, "evidence-private.key"); // created by the evidence test above
  assert.ok(fs.existsSync(key), "evidence key from the earlier test");
  const auditFile = path.join(TMP, "evidence-access.log");
  const before = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean).length : 0;

  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.authenticate({ username: "admin", password: "e2e-admin" });
  await page.goto(`http://127.0.0.1:${collectorPort}/admin`, { waitUntil: "networkidle0" });
  await page.click("#tab-analyst");
  const showBtn = async () => page.waitForFunction(() => [...document.querySelectorAll("#an-feed button")].find((b) => b.textContent === "Show original"));
  await (await showBtn()).click();
  // Locked: the unlock dialog opens first
  await page.waitForSelector("#unlock-dialog:not([hidden])");
  await page.type("#u-analyst", "e2e analyst");
  await page.type("#u-reason", "E2E dashboard reveal test");
  const input = await page.$("#u-key");
  await input.uploadFile(key);
  await page.type("#u-pass", "wrong passphrase");
  await page.click("#u-ok");
  await page.waitForFunction(() => /Wrong passphrase/.test(document.getElementById("u-msg").textContent), { timeout: 15000 });
  await page.$eval("#u-pass", (x) => { x.value = ""; });
  await page.type("#u-pass", "e2e passphrase 123");
  await page.click("#u-ok");
  await page.waitForFunction(() => document.querySelector("#an-feed .orig-label"), { timeout: 15000 });
  const feed = await page.$eval("#an-feed", (x) => x.textContent);
  assert.ok(feed.includes(ID2), "original (raw ID) shown after unlocking");
  assert.ok(await page.$("#an-feed mark.orig"), "sensitive values highlighted");

  const lines = fs.readFileSync(auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, before + 1, "exactly one audited reveal");
  assert.equal(lines.at(-1).analyst, "e2e analyst");
  assert.equal(lines.at(-1).via, "dashboard");
  const r = spawnSyncNode(["scripts/evidence.js", "verify-audit", "--audit", auditFile]);
  assert.equal(r.status, 0, "audit chain still intact");

  // Hide re-redacts; Lock removes everything
  await page.evaluate(() => [...document.querySelectorAll("#an-feed button")].find((b) => b.textContent === "Hide original").click());
  await page.waitForFunction((id) => !document.getElementById("an-feed").textContent.includes(id), {}, ID2);
  await page.click("#lock-btn");
  assert.equal(await page.$eval("#unlock-btn", (b) => b.hidden), false);
  assert.ok(!(await page.$eval("#an-feed", (x) => x.textContent)).includes(ID2));
  assert.deepEqual(errors, []);
  await page.close();
});


// ---------- network safety net ----------
// page.evaluate runs in the page's own world, so these requests go through the
// same wrapped fetch/XHR/sendBeacon the site's code would use.

const postedTo = (p) => posted.filter((x) => x.path === p);
async function waitPosted(p, n = 1) {
  for (let i = 0; i < 40 && postedTo(p).length < n; i++) await new Promise((r) => setTimeout(r, 50));
  return postedTo(p);
}

test("network: a fetch that bypasses the page check is redacted in flight + SOC alert", async () => {
  const page = await openSite("chatgpt");
  await page.evaluate((id) => fetch("/api/net-fetch", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft: { text: `autosaved draft for ${id}` }, ts: "1791381142023" }) }), ID1);
  const [got] = await waitPosted("/api/net-fetch");
  assert.ok(!got.body.includes(ID1), "raw ID must not leave the browser");
  assert.deepEqual(JSON.parse(got.body), { draft: { text: "autosaved draft for [SA_ID_NUMBER_1]" }, ts: "1791381142023" });
  const ev = (await flushAndReadLogs()).filter((e) => e["net.path"] === "/api/net-fetch");
  assert.equal(ev.length, 1);
  assert.equal(ev[0]["event.action"], "network_redacted");
  assert.equal(ev[0].layer, "network");
  assert.equal(ev[0]["alert.soc"], true);
  assert.ok(!JSON.stringify(ev[0]).includes(ID1), "log holds no raw ID");
  await page.close();
});

test("network: XHR, sendBeacon and Request objects are covered too", async () => {
  const page = await openSite("chatgpt");
  await page.evaluate((card, id) => {
    const x = new XMLHttpRequest();
    x.open("POST", "/api/net-xhr");
    x.send(JSON.stringify({ t: `card ${card}` }));
    navigator.sendBeacon("/api/net-beacon", `id=${id}`);
    return fetch(new Request("/api/net-req", { method: "POST", body: JSON.stringify({ t: id }) }));
  }, CARD, ID2);
  const [xhr] = await waitPosted("/api/net-xhr");
  const [beacon] = await waitPosted("/api/net-beacon");
  const [reqObj] = await waitPosted("/api/net-req");
  assert.equal(JSON.parse(xhr.body).t, "card [CREDIT_CARD_1]");
  assert.equal(beacon.body, "id=[SA_ID_NUMBER_1]");
  assert.equal(JSON.parse(reqObj.body).t, "[SA_ID_NUMBER_1]");
  await page.close();
});

test("network: clean and already-redacted requests pass byte-for-byte, no event", async () => {
  const page = await openSite("chatgpt");
  const body = JSON.stringify({ text: "Check client [SA_ID_NUMBER_1] for FICA", id: "3f2a9c1e-7b4d-4e8a-9f00-1234567890ab", n: 12345678901234567890 });
  await page.evaluate((b) => fetch("/api/net-clean", { method: "POST", body: b }), body);
  const [got] = await waitPosted("/api/net-clean");
  assert.equal(got.body, body);
  assert.equal((await flushAndReadLogs()).filter((e) => e["net.path"] === "/api/net-clean").length, 0);
  await page.close();
});

test("network: policy action 'block' stops the request; nothing reaches the server", async () => {
  const policy = JSON.parse(fs.readFileSync(path.join(EXT, "policy.default.json"), "utf8"));
  policy.network.action = "block";
  await setOptions({ ...BASE_OPTIONS(), policyJson: JSON.stringify(policy) });
  const page = await openSite("chatgpt");
  const err = await page.evaluate((id) => fetch("/api/net-block", { method: "POST", body: JSON.stringify({ t: id }) })
    .then(() => null, (e) => e.message), ID1);
  assert.match(err || "", /Blocked by Prompt Guard/);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(postedTo("/api/net-block").length, 0);
  const ev = (await flushAndReadLogs()).find((e) => e["net.path"] === "/api/net-block");
  assert.equal(ev["event.action"], "network_blocked");
  await page.close();
});

test("network: outside work (collector unreachable) the safety net is dormant", async () => {
  await setOptions({ ...BASE_OPTIONS(), collectorUrl: "http://127.0.0.1:9" });
  await new Promise((r) => setTimeout(r, 500));
  const page = await openSite("chatgpt");
  await page.evaluate((id) => fetch("/api/net-dormant", { method: "POST", body: JSON.stringify({ t: id }) }), ID1);
  const [got] = await waitPosted("/api/net-dormant");
  assert.equal(JSON.parse(got.body).t, ID1);
  await page.close();
});

function spawnSyncNode(args) {
  return require("node:child_process").spawnSync(process.execPath, args, { cwd: path.join(__dirname, "../.."), encoding: "utf8" });
}
