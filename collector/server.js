#!/usr/bin/env node
// Prompt Guard log collector. No dependencies.
//
// Receives batches of events from the extension, re-scrubs them as a safety
// net (logs must never hold raw PII), appends them to an NDJSON file and,
// if configured, bulk-indexes them into Elasticsearch.
//
// Env:
//   PG_TOKEN       required  bearer token the extension must send
//   PG_PORT        default 8787
//   PG_HOST        default 127.0.0.1
//   PG_OUT         default ./data/events.ndjson
//   ES_URL         optional  e.g. https://elastic.lab:9200
//   ES_API_KEY     optional  Elasticsearch API key (base64 id:key)
//   ES_INDEX       default prompt-guard-events
//   ES_INSECURE    "1" to accept self-signed certs (lab only)
//   PG_EVIDENCE    default ./data/evidence.ndjson (encrypted originals, never sent to ES)
//   PG_EVIDENCE_RETENTION_DAYS  default 30
//   PG_ADMIN_PASSWORD  enables the admin dashboard at /admin (user "admin")
//   PG_AUDIT       default ./data/evidence-access.log
//   PG_EXTENSION_ID  extension allowed to call the collector from a browser
//                    (CORS), default the Prompt Guard extension ID
//   PG_RATE_PER_MIN  max POST /events requests per client address per minute (default 120)

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const detectors = require("../extension/src/detectors.js");
const P = require("../extension/src/policy.js");
const evidenceStore = require("./evidence-store.js");
const admin = require("./admin.js");
const { RateLimiter, isLoopback } = require("./limits.js");

const TOKEN = process.env.PG_TOKEN;
const PORT = +(process.env.PG_PORT || 8787);
const HOST = process.env.PG_HOST || "127.0.0.1";
const OUT = process.env.PG_OUT || path.join(__dirname, "data", "events.ndjson");
const ES_URL = process.env.ES_URL || "";
const ES_API_KEY = process.env.ES_API_KEY || "";
const ES_INDEX = process.env.ES_INDEX || "prompt-guard-events";
const MAX_BODY = 5 * 1024 * 1024;
const EVIDENCE = process.env.PG_EVIDENCE || path.join(path.dirname(OUT), "evidence.ndjson");
const RETENTION_DAYS = +(process.env.PG_EVIDENCE_RETENTION_DAYS || 30);
const AUDIT = process.env.PG_AUDIT || path.join(path.dirname(OUT), "evidence-access.log");
const EXTENSION_ORIGIN = `chrome-extension://${process.env.PG_EXTENSION_ID || "nkfbgnhhnhdpimbkgkbeddiijbeoklgc"}`;
const MAX_EVENTS_PER_BATCH = 1000;
const MAX_FIELD_CHARS = 100000; // longer strings are truncated (and flagged)
const eventLimiter = new RateLimiter(+(process.env.PG_RATE_PER_MIN || 120), 60 * 1000);
// Fields only the collector may set; anything a client sends for them is dropped.
const SERVER_FIELDS = ["event.ingested", "source.ip", "collector.rescrubbed", "collector.truncated", "evidence.present"];

if (!TOKEN) {
  console.error("PG_TOKEN is required");
  process.exit(1);
}
const exposed = !isLoopback(HOST);
if (exposed && TOKEN.length < 24) {
  console.error("Refusing to start: PG_TOKEN must be at least 24 characters when the collector listens beyond this machine.");
  process.exit(1);
}

// The admin dashboard is only enabled with a strong password if reachable from other machines.
let adminPassword = process.env.PG_ADMIN_PASSWORD || "";
if (exposed && adminPassword && (adminPassword.length < 14 || adminPassword === "lab-admin")) {
  console.error("Admin dashboard DISABLED: PG_ADMIN_PASSWORD is too weak for a collector reachable from other machines (min 14 chars, not the lab default).");
  adminPassword = "";
}
const adminHandler = admin.makeHandler({ eventsFile: OUT, auditFile: AUDIT, evidenceFile: EVIDENCE, password: adminPassword });
if (process.env.ES_INSECURE === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

fs.mkdirSync(path.dirname(OUT), { recursive: true });

// Every detector result is redacted here regardless of the endpoint's policy.
const SCRUB_POLICY = { rules: [] }; // no rules -> everything defaults to log_only -> redacted in textToLog
const SCRUB_FIELDS = ["prompt.redacted", "override.justification", "net.path"];

function scrub(event) {
  let changed = false;
  for (const f of SCRUB_FIELDS) {
    const v = event[f];
    if (typeof v !== "string" || !v) continue;
    const dec = P.evaluate(detectors.detect(v), SCRUB_POLICY, {});
    if (dec.items.length) {
      event[f] = P.textToLog(v, dec, new P.Placeholders());
      changed = true;
    }
  }
  if (changed) event["collector.rescrubbed"] = true;
  return event;
}

function tokenOk(header) {
  const m = /^Bearer (.+)$/.exec(header || "");
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function toElastic(events) {
  if (!ES_URL) return;
  const body = events.map((e) => JSON.stringify({ create: { _index: ES_INDEX } }) + "\n" + JSON.stringify(e)).join("\n") + "\n";
  const headers = { "Content-Type": "application/x-ndjson" };
  if (ES_API_KEY) headers.Authorization = `ApiKey ${ES_API_KEY}`;
  const res = await fetch(ES_URL.replace(/\/$/, "") + "/_bulk", { method: "POST", headers, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) {
    const first = (json.items || []).find((i) => i.create && i.create.error);
    throw new Error(`ES bulk failed: HTTP ${res.status} ${first ? JSON.stringify(first.create.error) : ""}`);
  }
}

function send(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
    // Only the extension may call the collector from a browser; no wildcard.
    "Access-Control-Allow-Origin": EXTENSION_ORIGIN,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  });
  res.end(JSON.stringify(obj));
}

// Drop server-owned fields, cap string sizes, refuse nested junk keys.
function sanitizeEvent(e) {
  const out = {};
  let truncated = false;
  for (const [k, v] of Object.entries(e)) {
    if (SERVER_FIELDS.includes(k) || k === "__proto__" || k.length > 100) continue;
    if (typeof v === "string" && v.length > MAX_FIELD_CHARS) {
      out[k] = v.slice(0, MAX_FIELD_CHARS);
      truncated = true;
    } else {
      out[k] = v;
    }
  }
  if (truncated) out["collector.truncated"] = true;
  return out;
}

const server = http.createServer((req, res) => {
  if ((req.method === "GET" || req.method === "POST") && adminHandler(req, res)) return;
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });
  if (req.method !== "POST" || req.url !== "/events") return send(res, 404, { error: "not found" });
  if (!eventLimiter.take(req.socket.remoteAddress)) return send(res, 429, { error: "rate limited" });
  if (!tokenOk(req.headers.authorization)) return send(res, 401, { error: "unauthorized" });

  let size = 0;
  const chunks = [];
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BODY) {
      send(res, 413, { error: "too large" });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", async () => {
    if (res.writableEnded) return;
    let events;
    try {
      events = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!Array.isArray(events) || !events.every((e) => e && typeof e === "object" && !Array.isArray(e))) {
        throw new Error("body must be an array of objects");
      }
      if (events.length > MAX_EVENTS_PER_BATCH) throw new Error(`at most ${MAX_EVENTS_PER_BATCH} events per batch`);
    } catch (err) {
      return send(res, 400, { error: String(err.message) });
    }
    const now = new Date().toISOString();
    // Split encrypted evidence off first so it never reaches the normal log or ES.
    const evidence = [];
    const clean = events.map((e) => {
      const copy = { ...sanitizeEvent(e), "event.ingested": now, "source.ip": req.socket.remoteAddress };
      const rec = evidenceStore.split(copy);
      if (rec) evidence.push(rec);
      return scrub(copy);
    });
    try {
      evidenceStore.append(EVIDENCE, evidence);
      fs.appendFileSync(OUT, clean.map((e) => JSON.stringify(e)).join("\n") + "\n");
    } catch (err) {
      console.error("write failed:", err.message);
      return send(res, 500, { error: "storage failed" }); // extension keeps the batch and retries
    }
    try {
      await toElastic(clean);
    } catch (err) {
      // File copy is the source of truth; ES can be backfilled from it.
      console.error(err.message);
    }
    const alerts = clean.filter((e) => e["alert.soc"]).length;
    console.log(`${now} accepted ${clean.length} event(s)${alerts ? `, ${alerts} SOC alert(s)` : ""}`);
    send(res, 200, { accepted: clean.length });
  });
});

function purge() {
  try {
    const n = evidenceStore.purgeOld(EVIDENCE, RETENTION_DAYS);
    if (n) console.log(`purged ${n} evidence record(s) older than ${RETENTION_DAYS} days`);
  } catch (err) {
    console.error("evidence purge failed:", err.message);
  }
}
purge();
setInterval(purge, 3600 * 1000).unref();

if (exposed) {
  console.warn("WARNING: listening beyond this machine over plain HTTP. Tokens, logs and the admin password travel unencrypted.");
  console.warn("         Put the collector behind HTTPS (e.g. a Caddy/nginx reverse proxy) before using it with real users.");
}

server.listen(PORT, HOST, () => {
  console.log(`Prompt Guard collector on http://${HOST}:${PORT} -> ${OUT}${ES_URL ? ` + ${ES_URL}/${ES_INDEX}` : ""}`);
  console.log(`Encrypted evidence -> ${EVIDENCE} (kept ${RETENTION_DAYS} days, never sent to ES)`);
  console.log(adminPassword
    ? `Admin dashboard: http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}/admin  (user: admin)`
    : "Admin dashboard disabled (set PG_ADMIN_PASSWORD to enable)");
});
