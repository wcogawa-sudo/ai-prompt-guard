// Admin dashboard: serves collector/admin.html and its JSON API.
// Protected by HTTP Basic auth (user "admin", password PG_ADMIN_PASSWORD).
// Reads the collector's own files; never talks to Elasticsearch.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const audit = require("./audit.js");
const { RateLimiter } = require("./limits.js");

const DAY = 86400 * 1000;

// What counts as a prompt being sent (one per send attempt).
const SEND_ACTIONS = new Set(["prompt_sent", "prompt_sent_redacted", "prompt_blocked", "prompt_cancelled",
  "prompt_sent_unredacted", "redaction_failed"]);

// Outcome of a violation -> series in the chart. Order = categorical slot order.
const OUTCOMES = [
  { key: "redacted", label: "Redacted" },
  { key: "warned", label: "Redacted after warning" },
  { key: "cancelled", label: "Cancelled by user" },
  { key: "blocked", label: "Blocked" },
  { key: "override", label: "Sent unredacted (override)" },
];

function outcomeOf(e) {
  const a = e["event.action"] || "";
  if (a === "prompt_blocked" || a === "paste_blocked" || a === "file_blocked") return "blocked";
  if (a === "prompt_cancelled" || a === "paste_cancelled") return "cancelled";
  if (a === "prompt_sent_unredacted" || a === "paste_unredacted") return "override";
  if (a === "prompt_sent_redacted" || a === "paste_redacted") return e["user.decision"] === "accepted" ? "warned" : "redacted";
  return null; // not a violation
}

const CATEGORY_OF = {
  API_SECRET: "Secrets",
  KEYWORD: "Confidential terms",
};
function categoriesOf(e) {
  const cats = new Set();
  for (const d of e.detections || []) cats.add(CATEGORY_OF[d.type] || "Sensitive data");
  if ((e["event.action"] || "").startsWith("file_")) cats.add("Files");
  return cats;
}

function browserOf(ua) {
  const s = String(ua || "");
  if (/Edg\//.test(s)) return "Edge";
  if (/Firefox\//.test(s)) return "Firefox";
  if (/Chrome\//.test(s)) return "Chrome / Chromium";
  if (/Safari\//.test(s)) return "Safari";
  return "Unknown";
}

function localDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfLocalDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function readEvents(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* skip corrupt */ }
  }
  return out;
}

function matchesFilters(e, f) {
  if (f.user && e["user.name"] !== f.user) return false;
  if (f.site && e["ai.site"] !== f.site) return false;
  return true;
}

// days: period length ending now (1 = today). Compares with the previous period.
function summarize(events, opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  const days = Math.max(1, Math.min(365, +o.days || 7));
  const start = startOfLocalDay(now) - (days - 1) * DAY;
  const prevStart = start - days * DAY;
  const f = { user: o.user || "", site: o.site || "" };

  const inRange = (e, a, b) => { const t = Date.parse(e["@timestamp"]); return t >= a && t < b; };
  const cur = events.filter((e) => matchesFilters(e, f) && inRange(e, start, now + 1));
  const prev = events.filter((e) => matchesFilters(e, f) && inRange(e, prevStart, start));

  const count = (list) => {
    let prompts = 0;
    let violations = 0;
    for (const e of list) {
      if (SEND_ACTIONS.has(e["event.action"])) prompts++;
      if (outcomeOf(e)) violations++;
    }
    return { prompts, violations };
  };
  const c = count(cur);
  const p = count(prev);

  // Daily series
  const dayKeys = [];
  for (let i = 0; i < days; i++) dayKeys.push(localDay(start + i * DAY + DAY / 2));
  const daily = Object.fromEntries(dayKeys.map((k) => [k, { day: k, prompts: 0, ...Object.fromEntries(OUTCOMES.map((x) => [x.key, 0])) }]));

  const outcomes = Object.fromEntries(OUTCOMES.map((x) => [x.key, 0]));
  const categories = { "Sensitive data": 0, Secrets: 0, "Confidential terms": 0, Files: 0 };
  const browsers = {};
  const sites = {};
  const users = new Set();
  const allSites = new Set();

  for (const e of events) {
    if (e["user.name"]) users.add(e["user.name"]);
    if (e["ai.site"]) allSites.add(e["ai.site"]);
  }

  for (const e of cur) {
    const day = daily[localDay(e["@timestamp"])];
    const isSend = SEND_ACTIONS.has(e["event.action"]);
    const out = outcomeOf(e);
    if (day && isSend) day.prompts++;
    if (day && out) day[out]++;
    if (isSend) {
      const b = browserOf(e["browser.user_agent"]);
      browsers[b] = (browsers[b] || 0) + 1;
    }
    const siteKey = e["ai.site"] || "unknown";
    const s = sites[siteKey] || (sites[siteKey] = { site: siteKey, prompts: 0, violations: 0, categories: {} });
    if (isSend) s.prompts++;
    if (out) {
      outcomes[out]++;
      s.violations++;
      for (const cat of categoriesOf(e)) {
        categories[cat]++;
        s.categories[cat] = (s.categories[cat] || 0) + 1;
      }
    }
  }

  const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);
  return {
    range: { days, start: new Date(start).toISOString(), end: new Date(now).toISOString() },
    filters: f,
    totals: {
      prompts: c.prompts, violations: c.violations,
      promptsPrev: p.prompts, violationsPrev: p.violations,
      promptsDeltaPct: pct(c.prompts, p.prompts), violationsDeltaPct: pct(c.violations, p.violations),
    },
    outcomes,
    outcomeDefs: OUTCOMES,
    categories,
    browsers,
    sites: Object.values(sites).filter((s) => s.prompts || s.violations).sort((a, b) => b.violations - a.violations || b.prompts - a.prompts),
    daily: dayKeys.map((k) => daily[k]),
    choices: { users: [...users].sort(), sites: [...allSites].sort() },
  };
}

function recent(events, opts) {
  const o = opts || {};
  const f = { user: o.user || "", site: o.site || "" };
  const limit = Math.max(1, Math.min(500, +o.limit || 50));
  const days = Math.max(1, Math.min(365, +o.days || 7));
  const start = startOfLocalDay(o.now || Date.now()) - (days - 1) * DAY;
  const keep = ["@timestamp", "event.action", "user.name", "host.name", "ai.site", "user.decision", "detections",
    "prompt.redacted", "alert.soc", "bulk", "evidence.present", "evidence.id", "file.method", "file.count",
    "file.extensions", "override.justification", "stage"];
  return events.filter((e) => matchesFilters(e, f) && Date.parse(e["@timestamp"]) >= start).slice(-limit).reverse()
    .map((e) => Object.fromEntries(keep.filter((k) => e[k] !== undefined).map((k) => [k, e[k]])));
}

// Drill-down: what's behind a clicked chart segment, tile, site or category.
// opts: days, user, site (global filters) + kind ("prompts" | "violations" |
// "attention"), outcome (an OUTCOMES key), day ("YYYY-MM-DD"), category.
function isAttention(e) {
  return !!(e["alert.soc"] || e.bulk || /unredacted|redaction_failed/.test(e["event.action"] || ""));
}

function drill(events, opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  const days = Math.max(1, Math.min(365, +o.days || 7));
  const start = startOfLocalDay(now) - (days - 1) * DAY;
  const f = { user: o.user || "", site: o.site || "" };
  const kind = o.kind || "violations";
  const matched = events.filter((e) => {
    if (!matchesFilters(e, f)) return false;
    const t = Date.parse(e["@timestamp"]);
    if (!(t >= start && t <= now)) return false;
    if (o.day && localDay(e["@timestamp"]) !== o.day) return false;
    const out = outcomeOf(e);
    if (kind === "prompts" && !SEND_ACTIONS.has(e["event.action"])) return false;
    if (kind === "violations" && !out) return false;
    if (kind === "attention" && !isAttention(e)) return false;
    // kind "all": every event (sends, pastes, files) for the selection
    if (o.outcome && out !== o.outcome) return false;
    if (o.category && !categoriesOf(e).has(o.category)) return false;
    return true;
  });
  const byUser = {};
  for (const e of matched) {
    const u = e["user.name"] || "unknown";
    const r = byUser[u] || (byUser[u] = { user: u, count: 0, sites: new Set() });
    r.count++;
    if (e["ai.site"]) r.sites.add(e["ai.site"]);
  }
  const users = Object.values(byUser).map((r) => ({ user: r.user, count: r.count, sites: [...r.sites].sort() }))
    .sort((a, b) => b.count - a.count || a.user.localeCompare(b.user));
  const limit = Math.max(1, Math.min(500, +o.limit || 200));
  return {
    total: matched.length,
    users,
    events: recent(matched, { days, now, limit }),
  };
}

// ---------- HTTP ----------

function authorized(req, password) {
  const m = /^Basic (.+)$/.exec(req.headers.authorization || "");
  if (!m) return false;
  const [user, ...rest] = Buffer.from(m[1], "base64").toString("utf8").split(":");
  const given = Buffer.from(rest.join(":"));
  const want = Buffer.from(password);
  return user === "admin" && given.length === want.length && crypto.timingSafeEqual(given, want);
}

// Strict CSP: no inline or third-party scripts. Inline style attributes are
// still allowed (the charts set widths/colours via style).
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function readEvidenceRecord(file, id) {
  if (!fs.existsSync(file)) return null;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line || !line.includes(id)) continue;
    try { const r = JSON.parse(line); if (r.id === id) return r; } catch (_) { /* skip */ }
  }
  return null;
}

function makeHandler({ eventsFile, auditFile, evidenceFile, password }) {
  const html = path.join(__dirname, "admin.html");
  const appJs = path.join(__dirname, "admin-app.js");
  const failures = new RateLimiter(10, 10 * 60 * 1000); // 10 failed logins per 10 min per address
  return function handle(req, res) {
    const url = new URL(req.url, "http://x");
    if (!url.pathname.startsWith("/admin")) return false;
    const json = (status, obj) => {
      res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (!password) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("Admin dashboard disabled: start the collector with PG_ADMIN_PASSWORD set.");
      return true;
    }
    const who = req.socket.remoteAddress;
    if (failures.count(who) >= 10) {
      res.writeHead(429, { "Content-Type": "text/plain", "Retry-After": "600" });
      res.end("Too many failed logins. Try again in 10 minutes.");
      return true;
    }
    if (!authorized(req, password)) {
      if (req.headers.authorization) failures.take(who); // count real attempts, not the first challenge
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Prompt Guard admin", charset="UTF-8"', "Content-Type": "text/plain" });
      res.end("Login required (user: admin).");
      return true;
    }
    const q = Object.fromEntries(url.searchParams);

    // Reveal an original. The server can't decrypt (no private key here): it
    // logs the access FIRST, then returns the encrypted record, which the
    // admin's browser decrypts locally with the key the admin unlocked.
    if (url.pathname === "/admin/api/evidence/reveal") {
      if (req.method !== "POST") { json(405, { error: "POST only" }); return true; }
      // Only the dashboard itself may call this (blocks cross-site requests
      // riding on the browser's saved Basic-auth login).
      const origin = req.headers.origin;
      if ((origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) ||
        !/^application\/json\b/.test(req.headers["content-type"] || "")) {
        json(403, { error: "forbidden" });
        return true;
      }
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 10000) req.destroy(); });
      req.on("end", () => {
        let b;
        try { b = JSON.parse(body); } catch (_) { json(400, { error: "bad json" }); return; }
        const id = String(b.id || "");
        const analyst = String(b.analyst || "").trim().slice(0, 100);
        const reason = String(b.reason || "").trim().slice(0, 500);
        if (!/^[0-9a-f-]{36}$/.test(id)) { json(400, { error: "bad id" }); return; }
        if (!analyst || reason.length < 10) { json(400, { error: "analyst and a reason (10+ characters) are required" }); return; }
        const rec = readEvidenceRecord(evidenceFile, id);
        if (!rec) { json(404, { error: "no such evidence (it may have passed retention)" }); return; }
        audit.append(auditFile, {
          at: new Date().toISOString(), analyst, reason, evidence_id: id, subject_user: rec["user.name"] || null,
          via: "dashboard", source_ip: req.socket.remoteAddress,
        });
        json(200, { id, key_id: rec.key_id, alg: rec.alg, wrapped_key: rec.wrapped_key, iv: rec.iv, ciphertext: rec.ciphertext });
      });
      return true;
    }
    if (req.method !== "GET") { json(405, { error: "method not allowed" }); return true; }
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" });
      fs.createReadStream(html).pipe(res);
      return true;
    }
    if (url.pathname === "/admin/crypto.js") {
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/javascript; charset=utf-8" });
      fs.createReadStream(path.join(__dirname, "admin-crypto.js")).pipe(res);
      return true;
    }
    if (url.pathname === "/admin/app.js") {
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/javascript; charset=utf-8" });
      fs.createReadStream(appJs).pipe(res);
      return true;
    }
    if (url.pathname === "/admin/api/summary") { json(200, summarize(readEvents(eventsFile), q)); return true; }
    if (url.pathname === "/admin/api/events") { json(200, recent(readEvents(eventsFile), q)); return true; }
    if (url.pathname === "/admin/api/drill") { json(200, drill(readEvents(eventsFile), q)); return true; }
    if (url.pathname === "/admin/api/audit") {
      const entries = audit.readEntries(auditFile);
      json(200, { chain: audit.verify(auditFile), entries: entries.slice(-200).reverse() });
      return true;
    }
    json(404, { error: "not found" });
    return true;
  };
}

module.exports = { makeHandler, summarize, recent, drill, outcomeOf, browserOf };
