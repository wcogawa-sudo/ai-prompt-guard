// Service worker: builds the effective config (managed policy > local options
// > bundled default), keeps unapproved-AI redirect rules in sync, and ships
// log events to the collector with an offline queue.

const MAX_QUEUE = 5000;
const BATCH_SIZE = 200;
const REDIRECT_RULE_ID = 1;

// ---------- config ----------

async function getManaged() {
  try {
    return await chrome.storage.managed.get(null);
  } catch (_) {
    return {}; // no enterprise policy on this machine
  }
}

async function defaultPolicy() {
  const res = await fetch(chrome.runtime.getURL("policy.default.json"));
  return res.json();
}

async function ensureDeviceId() {
  const { deviceId } = await chrome.storage.local.get("deviceId");
  if (deviceId) return deviceId;
  const id = "dev-" + crypto.randomUUID();
  await chrome.storage.local.set({ deviceId: id });
  return id;
}

// A broken policy must never silently disable protection: fall back to the
// next source (ultimately the bundled default) and record the error.
function parsePolicy(json, source) {
  if (!json) return null;
  try {
    const p = JSON.parse(json);
    if (!p || !Array.isArray(p.rules)) throw new Error("policy has no rules array");
    return p;
  } catch (err) {
    chrome.storage.local.set({ policyError: { source, error: String(err.message || err), at: Date.now() } });
    return null;
  }
}

// Settings an admin pushes via enterprise policy always win over local options.
async function loadConfig() {
  const managed = await getManaged();
  const stored = (await chrome.storage.local.get("options")).options || {};
  // Security: once an organisation manages this extension (any enterprise
  // setting present), local options are ignored completely. Otherwise a user
  // could fill in whatever the admin didn't push (a permissive policy, warnings
  // off, logs sent elsewhere). Local options are for unmanaged lab installs only.
  const isManaged = Object.keys(managed).length > 0;
  const options = isManaged ? {} : stored;
  const pick = (k) => (managed[k] !== undefined && managed[k] !== "" ? managed[k] : options[k]);

  const config = {
    policy: parsePolicy(managed.policyJson, "managed") || parsePolicy(options.policyJson, "options") || (await defaultPolicy()),
    collectorUrl: pick("collectorUrl") || "",
    collectorToken: pick("collectorToken") || "",
    userName: pick("userName") || "unknown",
    deviceId: pick("deviceId") || (await ensureDeviceId()),
    group: pick("group") || null,
    managedKeys: Object.keys(managed),
  };
  // Extra names to always protect (local list adds to the policy's people list).
  const extraNames = String(pick("peopleNames") || "").split("\n").map((x) => x.trim()).filter(Boolean);
  if (extraNames.length) {
    const people = config.policy.people || {};
    config.policy = { ...config.policy, people: { ...people, names: [...(people.names || []), ...extraNames] } };
  }
  // Evidence key from the options box (the policy's own evidence block wins if enabled there).
  const evRaw = pick("evidenceConfig");
  if (evRaw && !(config.policy.evidence && config.policy.evidence.enabled)) {
    try {
      const e = JSON.parse(evRaw);
      const ev = e.evidence || e;
      if (ev.public_key_spki) config.policy = { ...config.policy, evidence: { enabled: true, public_key_spki: ev.public_key_spki, key_id: ev.key_id || "" } };
    } catch (err) {
      chrome.storage.local.set({ policyError: { source: "evidenceConfig", error: String(err.message || err), at: Date.now() } });
    }
  }
  // Warnings on/off switch (managed setting wins over the local checkbox).
  const w = managed.warningsEnabled !== undefined ? managed.warningsEnabled : options.warningsEnabled;
  if (typeof w === "boolean") config.policy = { ...config.policy, warning: { ...(config.policy.warning || {}), enabled: w } };
  // Content scripts only need the policy and group.
  await chrome.storage.local.set({ effective: { policy: config.policy, group: config.group } });
  await evaluateScope(config);
  return config;
}

let configPromise = null;
function config() {
  if (!configPromise) configPromise = loadConfig();
  return configPromise;
}
function reloadConfig() {
  configPromise = loadConfig();
  return configPromise;
}

// ---------- work-only scope ----------
// Monitoring only runs at work. "At work" = a work-only address (by default
// the collector's /health) is reachable, and/or it's within work hours.
// Outside work the extension is fully dormant: no warnings, no redaction,
// no logging, no site redirects.

function withinHours(hours, now) {
  if (!hours) return true;
  const d = now || new Date();
  if (Array.isArray(hours.days) && !hours.days.includes(d.getDay())) return false;
  const mins = d.getHours() * 60 + d.getMinutes();
  const toMins = (hhmm) => { const [h, m] = String(hhmm || "0:0").split(":").map(Number); return h * 60 + (m || 0); };
  const start = toMins(hours.start || "00:00");
  const end = toMins(hours.end || "23:59");
  return start <= end ? mins >= start && mins < end : mins >= start || mins < end; // overnight shifts
}

async function onWorkNetwork(cfg, scope) {
  const url = scope.probe_url || (cfg.collectorUrl ? cfg.collectorUrl.replace(/\/$/, "") + "/health" : "");
  if (!url) return { ok: false, why: "no work-network probe configured" };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
    clearTimeout(t);
    return { ok: res.ok, why: res.ok ? "work network reachable" : `probe returned HTTP ${res.status}` };
  } catch (_) {
    return { ok: false, why: "work network not reachable" };
  }
}

async function evaluateScope(cfg) {
  const scope = cfg.policy.scope || { mode: "always" };
  const mode = scope.mode || "always";
  let active = true;
  let reason = "always on";
  if (mode === "work_hours" || mode === "work_network_and_hours") {
    if (!withinHours(scope.hours)) { active = false; reason = "outside work hours"; }
    else reason = "within work hours";
  }
  if (active && (mode === "work_network" || mode === "work_network_and_hours")) {
    const net = await onWorkNetwork(cfg, scope);
    active = net.ok;
    reason = net.why + (mode === "work_network_and_hours" ? ", within work hours" : "");
  }
  const prev = (await chrome.storage.local.get("scopeState")).scopeState;
  const scopeState = { active, reason, mode, checkedAt: Date.now() };
  await chrome.storage.local.set({ scopeState });
  if (prev && prev.active !== active) console.log(`Prompt Guard ${active ? "active" : "dormant"}: ${reason}`);
  await syncSiteRules(cfg.policy, active);
  return scopeState;
}

let scopeRunning = null;
function checkScope() {
  if (!scopeRunning) scopeRunning = config().then(evaluateScope).finally(() => { scopeRunning = null; });
  return scopeRunning;
}

// ---------- unapproved AI sites ----------

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function syncSiteRules(policy, active) {
  if (active === undefined) {
    const { scopeState } = await chrome.storage.local.get("scopeState");
    active = !!(scopeState && scopeState.active);
  }
  const sites = active ? (policy.sites || {}) : {}; // no redirects outside work
  const approved = new Set(sites.approved || []);
  const domains = (sites.unapproved || []).filter((d) => !approved.has(d));
  const rules = [];
  if (domains.length) {
    const action = sites.unapproved_action === "block"
      ? { type: "block" }
      : {
        type: "redirect",
        redirect: { regexSubstitution: `chrome-extension://${chrome.runtime.id}/blocked.html?site=\\1` },
      };
    rules.push({
      id: REDIRECT_RULE_ID,
      priority: 1,
      action,
      condition: {
        // Capture the hostname for the blocked page. requestDomains also
        // matches subdomains (www.perplexity.ai etc.).
        // ".*$" consumes the whole URL so only our substitution remains.
        regexFilter: "^https?://([^/:]+).*$",
        requestDomains: domains,
        resourceTypes: ["main_frame"],
      },
    });
  }
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: rules,
  });
}

// ---------- evidence encryption ----------
// Originals are encrypted here, before they are queued or uploaded, with the
// org's PUBLIC key from the policy (hybrid RSA-OAEP-256 + AES-256-GCM). Only
// the holder of the matching private key can read them; the collector can't.

function b64ToBytes(b64) {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function keyIdFor(spkiBytes) {
  const h = await crypto.subtle.digest("SHA-256", spkiBytes);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

let cachedKey = { spki: null, key: null, keyId: null };
async function evidenceKey(cfg) {
  if (cachedKey.spki === cfg.public_key_spki) return cachedKey;
  const spki = b64ToBytes(cfg.public_key_spki);
  const key = await crypto.subtle.importKey("spki", spki, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  cachedKey = { spki: cfg.public_key_spki, key, keyId: await keyIdFor(spki) };
  return cachedKey;
}

async function encryptEvidence(plain, cfg) {
  const { key, keyId } = await evidenceKey(cfg);
  if (cfg.key_id && cfg.key_id !== keyId) throw new Error("public key does not match key_id in policy");
  const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(plain));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, data);
  const rawAes = await crypto.subtle.exportKey("raw", aes);
  const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, rawAes);
  return {
    alg: "RSA-OAEP-256+A256GCM",
    key_id: keyId,
    wrapped_key: bytesToB64(wrapped),
    iv: bytesToB64(iv),
    ciphertext: bytesToB64(ciphertext), // AES-GCM output: ciphertext followed by 16-byte tag
  };
}

// ---------- logging queue ----------

// Serialise queue updates so concurrent messages don't overwrite each other.
let queueLock = Promise.resolve();
function withQueue(fn) {
  const run = queueLock.then(async () => {
    const { queue = [], dropped = 0 } = await chrome.storage.local.get(["queue", "dropped"]);
    const res = await fn(queue, dropped);
    await chrome.storage.local.set({ queue: res.queue, dropped: res.dropped });
    return res.result;
  });
  queueLock = run.catch(() => {});
  return run;
}

async function enqueue(event, sender, evidencePlain) {
  const cfg = await config();
  const { scopeState } = await chrome.storage.local.get("scopeState");
  if (!scopeState || !scopeState.active) return; // outside work: never log
  const ev = cfg.policy.evidence || {};
  let evidenceFields = {};
  if (evidencePlain && ev.enabled) {
    try {
      if (!ev.public_key_spki) throw new Error("evidence enabled but no public key in policy");
      evidenceFields = { "evidence.id": crypto.randomUUID(), evidence: await encryptEvidence(evidencePlain, ev) };
    } catch (err) {
      // Never fall back to storing plain text: send without evidence, flag it.
      evidenceFields = { "evidence.error": String(err.message || err) };
    }
  }
  const enriched = {
    ...evidenceFields,
    ...event,
    "user.name": cfg.userName,
    "user.group": cfg.group,
    "host.name": cfg.deviceId,
    "extension.version": chrome.runtime.getManifest().version,
    "browser.user_agent": navigator.userAgent,
    "tab.url_host": sender && sender.url ? new URL(sender.url).hostname : null,
  };
  await withQueue(async (queue, dropped) => {
    queue.push(enriched);
    let d = dropped;
    if (queue.length > MAX_QUEUE) {
      d += queue.length - MAX_QUEUE;
      queue.splice(0, queue.length - MAX_QUEUE);
    }
    return { queue, dropped: d };
  });
  flush(); // fire and forget; alarms retry on failure
}

let flushing = false;
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    const cfg = await config();
    if (!cfg.collectorUrl) return; // nowhere to send yet; keep queuing
    for (;;) {
      const { queue = [] } = await chrome.storage.local.get("queue");
      if (!queue.length) break;
      const batch = queue.slice(0, BATCH_SIZE);
      const res = await fetch(cfg.collectorUrl.replace(/\/$/, "") + "/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.collectorToken}` },
        body: JSON.stringify(batch),
      });
      if (!res.ok) throw new Error(`collector HTTP ${res.status}`);
      await withQueue(async (q, dropped) => ({ queue: q.slice(batch.length), dropped }));
      await chrome.storage.local.set({ lastFlush: { ok: true, at: Date.now(), sent: batch.length } });
    }
  } catch (err) {
    await chrome.storage.local.set({ lastFlush: { ok: false, at: Date.now(), error: String(err.message || err) } });
  } finally {
    flushing = false;
  }
}

// ---------- wiring ----------

function setupAlarms() {
  chrome.alarms.create("flush", { periodInMinutes: 1 });
  chrome.alarms.create("scope", { periodInMinutes: 1 }); // notice arriving at / leaving work
}
chrome.runtime.onInstalled.addListener(() => { reloadConfig(); setupAlarms(); });
chrome.runtime.onStartup.addListener(() => { reloadConfig(); setupAlarms(); });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "flush") flush();
  if (a.name === "scope") checkScope();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "managed" || (area === "local" && changes.options)) reloadConfig().then(flush);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "log") {
    enqueue(msg.event, sender, msg.evidence);
    return false;
  }
  if (msg.type === "status") {
    (async () => {
      const cfg = await config();
      const s = await chrome.storage.local.get(["queue", "dropped", "lastFlush"]);
      sendResponse({
        userName: cfg.userName, deviceId: cfg.deviceId, group: cfg.group,
        collectorUrl: cfg.collectorUrl, policyVersion: cfg.policy.version,
        scope: (await chrome.storage.local.get("scopeState")).scopeState || null,
        warningsEnabled: cfg.policy.warning ? cfg.policy.warning.enabled : undefined,
        evidence: cfg.policy.evidence && cfg.policy.evidence.enabled ? (cfg.policy.evidence.key_id || "set") : null,
        managedKeys: cfg.managedKeys, managed: cfg.managedKeys.length > 0, queued: (s.queue || []).length,
        dropped: s.dropped || 0, lastFlush: s.lastFlush || null,
      });
    })();
    return true;
  }
  if (msg.type === "getRedirectTarget") {
    config().then((cfg) => sendResponse((cfg.policy.sites || {}).redirect_to || null));
    return true;
  }
  if (msg.type === "checkScope") {
    checkScope().then((st) => sendResponse(st));
    return true;
  }
  if (msg.type === "flushNow") {
    flush().then(() => sendResponse(true));
    return true;
  }
  return false;
});
