// Encrypted evidence store. Holds originals encrypted by the extension with the
// org's public key; the collector cannot decrypt them. Kept in its own file,
// separate from the normal log, and never forwarded to Elasticsearch.

const fs = require("node:fs");

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ID = /^[0-9a-f-]{36}$/;

// Validate the shape the extension sends. Rejects anything that isn't
// ciphertext, so plain text can't be smuggled into the evidence store.
function validEvidence(id, ev) {
  return typeof id === "string" && ID.test(id) &&
    ev && typeof ev === "object" &&
    ev.alg === "RSA-OAEP-256+A256GCM" &&
    typeof ev.key_id === "string" && /^[0-9a-f]{16}$/.test(ev.key_id) &&
    ["wrapped_key", "iv", "ciphertext"].every((k) => typeof ev[k] === "string" && B64.test(ev[k]));
}

// Pull the evidence blob out of an event. Returns the evidence record to
// store (or null) and mutates the event so the normal log keeps only a pointer.
function split(event) {
  const ev = event.evidence;
  delete event.evidence;
  if (ev === undefined) return null;
  const id = event["evidence.id"];
  if (!validEvidence(id, ev)) {
    delete event["evidence.id"];
    event["evidence.error"] = "rejected_invalid_evidence";
    return null;
  }
  event["evidence.present"] = true;
  return {
    id,
    "@timestamp": event["@timestamp"],
    "stored_at": new Date().toISOString(),
    "user.name": event["user.name"],
    "host.name": event["host.name"],
    "ai.site": event["ai.site"],
    "event.action": event["event.action"],
    ...ev,
  };
}

function append(file, records) {
  if (!records.length) return;
  fs.appendFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
}

// Delete evidence older than `days`. Rewrites the file atomically.
function purgeOld(file, days, now) {
  if (!fs.existsSync(file)) return 0;
  const cutoff = (now || Date.now()) - days * 86400 * 1000;
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const keep = lines.filter((l) => {
    try {
      return Date.parse(JSON.parse(l).stored_at) >= cutoff;
    } catch (_) {
      return false; // drop corrupt lines
    }
  });
  const removed = lines.length - keep.length;
  if (removed) {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, keep.length ? keep.join("\n") + "\n" : "", { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  return removed;
}

module.exports = { split, append, purgeOld, validEvidence };
