#!/usr/bin/env node
// Readable view of the collector's prompt log.
//
//   npm run logs                       last 50 events
//   npm run logs -- --follow           keep watching for new events (Ctrl+C to stop)
//   npm run logs -- --user will --site chatgpt.com --action blocked --last 200
//   npm run logs -- --alerts           only events flagged for the SOC
//   npm run logs -- --json             raw JSON lines (for piping into jq)
//
// Shows the REDACTED prompt only. Originals live in the encrypted evidence
// store: `npm run evidence -- view <evidence-id> ...`

const fs = require("node:fs");
const path = require("node:path");

const { safeText } = require("./safe-text.js");
const FILE = process.env.PG_OUT || path.join(__dirname, "..", "collector", "data", "events.ndjson");

const a = { last: 50 };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const k = argv[i].replace(/^--/, "");
  if (["follow", "alerts", "json"].includes(k)) a[k] = true;
  else a[k] = argv[++i];
}

const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const COLOR = {
  prompt_sent: 0, prompt_sent_redacted: 36, paste_redacted: 36,
  prompt_cancelled: 33, paste_cancelled: 33, false_positive_report: 33,
  prompt_blocked: 31, paste_blocked: 31, prompt_sent_unredacted: 35, paste_unredacted: 35,
  redaction_failed: 31, adapter_degraded: 90,
};

function matches(e) {
  if (a.user && e["user.name"] !== a.user) return false;
  if (a.site && !String(e["ai.site"] || "").includes(a.site)) return false;
  if (a.action && !String(e["event.action"] || "").includes(a.action)) return false;
  if (a.alerts && !e["alert.soc"]) return false;
  return true;
}

function fmt(raw) {
  if (a.json) return JSON.stringify(raw); // JSON.stringify escapes control characters itself
  // Every field is untrusted (users write prompts; clients send events).
  const e = JSON.parse(JSON.stringify(raw), (k, v) => (typeof v === "string" ? safeText(v) : v));
  const t = new Date(e["@timestamp"]);
  const when = isNaN(t) ? "?" : t.toLocaleString("en-ZA", { dateStyle: "short", timeStyle: "medium" });
  const action = e["event.action"] || "?";
  const flags = [
    e["alert.soc"] ? c(41, " SOC ") : "",
    e.bulk ? c(31, "[bulk]") : "",
    e["evidence.present"] ? c(32, `[evidence ${e["evidence.id"]}]`) : "",
    e["evidence.error"] ? c(31, `[evidence error: ${e["evidence.error"]}]`) : "",
  ].filter(Boolean).join(" ");
  const dets = (e.detections || []).map((d) => `${d.type}x${d.count}`).join(", ");
  const head = `${c(90, when)}  ${(e["user.name"] || "?").padEnd(10)} ${(e["host.name"] || "").padEnd(16)} ${(e["ai.site"] || "").padEnd(14)} ${c(COLOR[action] ?? 0, action)}` +
    (e["user.decision"] && e["user.decision"] !== "none" ? ` (${e["user.decision"]})` : "") +
    (flags ? "  " + flags : "");
  const lines = [head];
  if (dets) lines.push(`    detected: ${dets}`);
  if (e["prompt.redacted"]) lines.push("    " + e["prompt.redacted"].replace(/\n/g, "\n    "));
  if (e["override.justification"]) lines.push(`    justification: ${e["override.justification"]}`);
  return lines.join("\n");
}

function parse(text) {
  return text.split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean);
}

if (!fs.existsSync(FILE)) {
  console.log(`No log yet at ${FILE}. Is the collector running and has anything been sent?`);
  if (!a.follow) process.exit(0);
}

let offset = 0;
function readNew(limit) {
  if (!fs.existsSync(FILE)) return;
  const size = fs.statSync(FILE).size;
  if (size < offset) offset = 0; // file was rotated/replaced
  if (size === offset) return;
  const fd = fs.openSync(FILE, "r");
  const buf = Buffer.alloc(size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  // only consume complete lines
  const text = buf.toString("utf8");
  const end = text.lastIndexOf("\n") + 1;
  offset += Buffer.byteLength(text.slice(0, end));
  let events = parse(text.slice(0, end)).filter(matches);
  if (limit) events = events.slice(-limit);
  for (const e of events) console.log(fmt(e) + (a.json ? "" : "\n"));
}

readNew(+a.last);
if (a.follow) {
  if (!a.json) console.log(c(90, "-- watching for new prompts (Ctrl+C to stop) --\n"));
  setInterval(() => readNew(0), 1000);
}
