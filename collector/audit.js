// Hash-chained evidence access log. Each entry stores the hash of the previous
// entry, so editing or deleting any entry breaks the chain from that point.
// Shared by scripts/evidence.js (writes + verifies) and the admin dashboard.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function lines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
}

function entryHash(prevHash, body) {
  return crypto.createHash("sha256").update(prevHash + JSON.stringify(body)).digest("hex");
}

function append(file, body) {
  const all = lines(file);
  const prev = all.length ? JSON.parse(all[all.length - 1]).hash : "genesis";
  const entry = { ...body, prev, hash: entryHash(prev, body) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
}

// { ok, entries, brokenAt } - brokenAt is the 1-based entry where the chain breaks.
function verify(file) {
  const all = lines(file);
  let prev = "genesis";
  for (let i = 0; i < all.length; i++) {
    let parsed;
    try { parsed = JSON.parse(all[i]); } catch (_) { return { ok: false, entries: all.length, brokenAt: i + 1 }; }
    const { prev: p, hash, ...body } = parsed;
    if (p !== prev || hash !== entryHash(prev, body)) return { ok: false, entries: all.length, brokenAt: i + 1 };
    prev = hash;
  }
  return { ok: true, entries: all.length, brokenAt: null };
}

function readEntries(file) {
  return lines(file).map((l) => {
    try {
      const { prev, hash, ...body } = JSON.parse(l);
      return body;
    } catch (_) {
      return { corrupt: true };
    }
  });
}

module.exports = { append, verify, readEntries, entryHash };
