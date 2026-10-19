// Policy evaluation and placeholder redaction. Pure functions, shared with tests.

(function (root) {
  "use strict";

  // Higher number = stricter. The strictest action across all detections wins.
  const SEVERITY = { allow: 0, log_only: 1, redact_silent: 2, redact_warn: 3, block: 4 };
  const REDACTING = new Set(["redact_silent", "redact_warn"]);

  function stricter(a, b) {
    return (SEVERITY[a] || 0) >= (SEVERITY[b] || 0) ? a : b;
  }

  // Find the rule for a detection. KEYWORD rules match on their value list.
  function ruleFor(det, policy) {
    const rules = policy.rules || [];
    if (det.type === "KEYWORD") {
      const v = det.value.toLowerCase();
      return rules.find((r) => r.type === "KEYWORD" &&
        (r.values || []).some((x) => x.trim().toLowerCase() === v)) || null;
    }
    return rules.find((r) => r.type === det.type) || null;
  }

  function allKeywords(policy) {
    return (policy.rules || [])
      .filter((r) => r.type === "KEYWORD")
      .flatMap((r) => r.values || []);
  }

  // ctx: { group, snoozedTypes: Set<string> }
  // Returns the decision for one prompt.
  function evaluate(detections, policy, ctx) {
    const context = ctx || {};
    const snoozed = context.snoozedTypes || new Set();
    const groupOverrides = (policy.groups && context.group && policy.groups[context.group]) || {};
    const warningsOn = policy.warning ? policy.warning.enabled : undefined;

    const items = [];
    let action = "allow";
    let alertSoc = false;

    for (const det of detections) {
      const rule = ruleFor(det, policy);
      if (rule && rule.min_confidence != null && det.confidence < rule.min_confidence) continue;

      let itemAction = (rule && rule.action) || "log_only";
      if (groupOverrides[det.type]) itemAction = groupOverrides[det.type];
      // Global warning switch: on = every redaction is confirmed by the user
      // first; off = no pop-ups at all. Unset = each rule decides.
      if (warningsOn === true && itemAction === "redact_silent") itemAction = "redact_warn";
      if (warningsOn === false && itemAction === "redact_warn") itemAction = "redact_silent";
      if (itemAction === "redact_warn" && snoozed.has(det.type)) itemAction = "redact_silent";

      if (itemAction !== "allow" && rule && rule.alert_soc) alertSoc = true;
      items.push({ ...det, action: itemAction });
      action = stricter(action, itemAction);
    }

    // Bulk: lots of sensitive values in one prompt looks like a data dump.
    let bulk = false;
    const bt = policy.bulk_threshold;
    // Optionally only strong identifiers count (an email thread full of names
    // shouldn't be treated as a data dump).
    const counted = items.filter((i) => i.action !== "allow" && (!bt || !bt.types || bt.types.includes(i.type))).length;
    if (bt && bt.count && counted >= bt.count) {
      bulk = true;
      action = stricter(action, bt.action || "block");
      if (bt.alert_soc) alertSoc = true;
    }

    const counts = {};
    for (const i of items) counts[i.type] = (counts[i.type] || 0) + 1;

    const warnTypes = [...new Set(items.filter((i) => i.action === "redact_warn").map((i) => i.type))];
    const blockTypes = [...new Set(items.filter((i) => i.action === "block").map((i) => i.type))];

    return { action, items, counts, warnTypes, blockTypes, bulk, alertSoc };
  }

  // Consistent placeholders: the same value always gets the same token within
  // one conversation, so the AI can still tell [PERSON_1] from [PERSON_2].
  // The mapping lives in memory only and is never logged or sent.
  class Placeholders {
    constructor() {
      this.map = new Map();
      this.counters = {};
    }
    static normalize(type, value) {
      if (type === "SA_ID_NUMBER" || type === "CREDIT_CARD" || type === "PHONE_NUMBER") {
        return value.replace(/[^\d+]/g, "");
      }
      return value.trim().toLowerCase();
    }
    tokenFor(type, value) {
      const key = type + "\u0000" + Placeholders.normalize(type, value);
      let token = this.map.get(key);
      if (!token) {
        this.counters[type] = (this.counters[type] || 0) + 1;
        token = `[${type}_${this.counters[type]}]`;
        this.map.set(key, token);
      }
      return token;
    }
  }

  // Replace the selected items with placeholders. `shouldRedact(item)` picks
  // which items to replace. Items must not overlap (detectors guarantee that).
  function redact(text, items, placeholders, shouldRedact) {
    const pick = shouldRedact || ((i) => REDACTING.has(i.action));
    // Assign tokens in reading order so numbering is natural ([X_1] first).
    const chosen = items.filter(pick).sort((a, b) => a.start - b.start);
    const tokens = chosen.map((i) => placeholders.tokenFor(i.type, i.value));
    let out = text;
    for (let k = chosen.length - 1; k >= 0; k--) {
      const i = chosen[k];
      out = out.slice(0, i.start) + tokens[k] + out.slice(i.end);
    }
    return out;
  }

  // Text to send to the AI: only redact/warn items are replaced.
  function textToSend(text, decision, placeholders) {
    return redact(text, decision.items, placeholders, (i) => REDACTING.has(i.action));
  }

  // Text to log: everything detected is replaced (logs must never hold raw PII),
  // except items an admin explicitly allowed.
  function textToLog(text, decision, placeholders) {
    return redact(text, decision.items, placeholders, (i) => i.action !== "allow");
  }

  const api = { evaluate, redact, textToSend, textToLog, allKeywords, Placeholders, SEVERITY, stricter };
  root.PG = root.PG || {};
  root.PG.policy = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
