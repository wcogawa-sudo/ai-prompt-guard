// Network safety net: scan an outgoing request body for confirmed sensitive
// values and replace them in the raw body text. Pure functions, no browser
// APIs, so the same file runs in the content script and in Node tests.
//
// The page-level (DOM) check normally redacts before the site sends, so this
// layer should find nothing. A hit means something bypassed the page check
// (a draft autosave, an unknown text box, a script), which is worth a SOC alert.
//
// Only high-confidence types are checked here (checksum-valid IDs and cards,
// API secrets): request bodies are full of timestamps and record ids, so
// "possible" matches would cause false positives.

(function (root) {
  "use strict";

  const DEFAULT_TYPES = ["SA_ID_NUMBER", "CREDIT_CARD", "API_SECRET"];
  const MAX_BODY = 1024 * 1024;   // larger bodies pass unscanned (files go through the file policy)
  const MAX_STRINGS = 5000;       // cap on JSON string leaves scanned per body

  // Collect the string values of a JSON document (keys too: some sites put
  // text in keys). Returns null if the body isn't JSON.
  function jsonStrings(body) {
    const first = body.trimStart()[0];
    if (first !== "{" && first !== "[") return null;
    let doc;
    try { doc = JSON.parse(body); } catch (_) { return null; }
    // Iterative walk: a deeply nested body must not overflow the stack (an
    // exception here would let the request through unscanned).
    const out = [];
    const stack = [doc];
    while (stack.length && out.length < MAX_STRINGS) {
      const v = stack.pop();
      if (typeof v === "string") out.push(v);
      else if (Array.isArray(v)) { for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]); }
      else if (v && typeof v === "object") {
        const entries = Object.entries(v);
        for (let i = entries.length - 1; i >= 0; i--) {
          stack.push(entries[i][1]);
          if (entries[i][0].length > 12) stack.push(entries[i][0]);
        }
      }
    }
    return out;
  }

  // How a value appears inside the raw body. In JSON it's the escaped form.
  function rawForm(value, isJson) {
    return isJson ? JSON.stringify(value).slice(1, -1) : value;
  }

  function normalize(type, value) {
    return type === "API_SECRET" ? value.trim() : value.replace(/[^\d]/g, "");
  }

  // opts:
  //   detect(text)            -> detections (detectors.detect)
  //   types                   -> types checked (default DEFAULT_TYPES)
  //   allowValues             -> Set of type+"\0"+normalized values the user chose to send unredacted
  //   tokenFor(type, value)   -> placeholder (shared with the DOM layer)
  //   ruleAction(det)         -> policy action for this detection ("allow"|"log_only"|"redact_*"|"block")
  //
  // Returns { scanned, hits, enforce, body, verified }
  //   hits:     every confirmed detection [{type, value, action}]
  //   enforce:  hits whose policy action redacts or blocks
  //   body:     the body with enforced values replaced by placeholders
  //   verified: true if a re-scan of the new body finds no enforced value
  // Find confirmed detections in a body (no changes made).
  function find(body, o) {
    const types = new Set(o.types && o.types.length ? o.types : DEFAULT_TYPES);
    const allow = o.allowValues || new Set();
    const strings = jsonStrings(body);
    const isJson = strings !== null;
    const segments = isJson ? strings : [body];
    const seen = new Map(); // dedupe by type+normalized value
    for (const seg of segments) {
      if (!seg || seg.length < 6) continue;
      for (const d of o.detect(seg)) {
        if (!types.has(d.type) || d.possible) continue;
        const key = d.type + "\u0000" + normalize(d.type, d.value);
        if (seen.has(key) || allow.has(key)) continue;
        seen.set(key, { type: d.type, value: d.value, confidence: d.confidence,
          action: o.ruleAction ? o.ruleAction(d) : "redact_silent" });
      }
    }
    const hits = [...seen.values()].filter((h) => h.action !== "allow");
    const enforce = hits.filter((h) => h.action !== "log_only");
    return { isJson, hits, enforce };
  }

  function scan(body, opts) {
    const o = opts || {};
    if (typeof body !== "string" || !body || body.length > MAX_BODY) {
      return { scanned: false, hits: [], enforce: [], body, verified: true };
    }
    const { isJson, hits, enforce } = find(body, o);
    if (!enforce.length) return { scanned: true, hits, enforce, body, verified: true };

    // Replace in the raw text so the site's own formatting (and big numbers
    // JSON.parse would round) stay exactly as they were.
    let out = body;
    for (const h of enforce) {
      out = out.split(rawForm(h.value, isJson)).join(o.tokenFor(h.type, h.value));
    }
    // Fail-safe: the new body must still parse (if it was JSON) and a fresh
    // scan must find no enforced value. Otherwise the caller blocks the request.
    let verified = true;
    if (isJson) {
      try { JSON.parse(out); } catch (_) { verified = false; }
    }
    if (verified) verified = !find(out, o).enforce.length;
    return { scanned: true, hits, enforce, body: out, verified };
  }

  const api = { scan, jsonStrings, normalize, DEFAULT_TYPES, MAX_BODY };
  root.PG = root.PG || {};
  root.PG.netscan = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
