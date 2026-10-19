// Warning / block dialogs and the "protected" badge. Rendered in a closed
// shadow root so the AI site's CSS can't break it (and it can't break the site).
// User-supplied text is only ever set via textContent, never innerHTML.

(function (root) {
  "use strict";

  const LABELS = {
    SA_ID_NUMBER: ["SA ID number", "SA ID numbers"],
    CREDIT_CARD: ["card number", "card numbers"],
    API_SECRET: ["password / API key", "passwords / API keys"],
    EMAIL: ["email address", "email addresses"],
    PHONE_NUMBER: ["phone number", "phone numbers"],
    KEYWORD: ["confidential term", "confidential terms"],
    PASSPORT: ["passport number", "passport numbers"],
    BANK_ACCOUNT: ["bank account number", "bank account numbers"],
    TAX_NUMBER: ["tax number", "tax numbers"],
    MEMBER_NUMBER: ["member / policy number", "member / policy numbers"],
    DATE_OF_BIRTH: ["date of birth", "dates of birth"],
    IP_ADDRESS: ["IP address", "IP addresses"],
    ADDRESS: ["street address", "street addresses"],
    PERSON_NAME: ["name", "names"],
    LONG_NUMBER: ["long number (possible account or reference)", "long numbers (possible accounts or references)"],
  };

  function describe(type, n) {
    const l = LABELS[type] || [type, type];
    return `${n} ${n === 1 ? l[0] : l[1]}`;
  }

  const CSS = `
    :host { all: initial; }
    .backdrop { position: fixed; inset: 0; background: rgba(15,23,42,.45); z-index: 2147483646;
      display: flex; align-items: center; justify-content: center; font: 14px/1.45 system-ui, sans-serif; }
    .dialog { background: #fff; color: #0f172a; width: min(520px, calc(100vw - 32px)); border-radius: 12px;
      box-shadow: 0 20px 50px rgba(0,0,0,.3); padding: 20px 22px; box-sizing: border-box; }
    h2 { font-size: 16px; margin: 0 0 10px; display: flex; gap: 8px; align-items: center; }
    p { margin: 6px 0; }
    ul { margin: 6px 0 10px 18px; padding: 0; }
    .preview { background: #f1f5f9; border-radius: 8px; padding: 10px 12px; margin: 10px 0;
      font: 12.5px/1.5 ui-monospace, monospace; white-space: pre-wrap; word-break: break-word; max-height: 160px; overflow: auto; }
    .ph { background: #dbeafe; color: #1e3a8a; border-radius: 4px; padding: 0 3px; }
    .row { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; margin-top: 14px; }
    button { font: inherit; border-radius: 8px; padding: 8px 14px; cursor: pointer; border: 1px solid #cbd5e1; background: #fff; color: #0f172a; }
    button.primary { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
    button.danger { background: #fff; border-color: #b91c1c; color: #b91c1c; }
    button:focus-visible { outline: 3px solid #93c5fd; outline-offset: 1px; }
    .links { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 10px; font-size: 12.5px; }
    .link { background: none; border: none; padding: 0; color: #1d4ed8; text-decoration: underline; cursor: pointer; }
    label { display: flex; gap: 6px; align-items: center; font-size: 12.5px; margin-top: 8px; }
    textarea { width: 100%; box-sizing: border-box; font: inherit; margin-top: 6px; border-radius: 6px; border: 1px solid #cbd5e1; padding: 6px; }
    .muted { color: #475569; font-size: 12.5px; }
    .block h2 { color: #b91c1c; }
    .toast { position: fixed; bottom: 18px; right: 18px; z-index: 2147483647; background: #0f172a; color: #fff;
      padding: 8px 12px; border-radius: 8px; font: 13px system-ui, sans-serif; box-shadow: 0 6px 20px rgba(0,0,0,.25); }
    @media (prefers-color-scheme: dark) {
      .dialog { background: #1e293b; color: #e2e8f0; }
      .preview { background: #0f172a; }
      .ph { background: #1e3a8a; color: #dbeafe; }
      button { background: #1e293b; color: #e2e8f0; border-color: #475569; }
      button.danger { color: #fca5a5; border-color: #fca5a5; background: #1e293b; }
      .link { color: #93c5fd; } .muted { color: #94a3b8; }
      .block h2 { color: #fca5a5; }
      textarea { background: #0f172a; color: #e2e8f0; border-color: #475569; }
    }`;

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of children) if (c != null) e.append(c);
    return e;
  }

  function mount() {
    const host = document.createElement("prompt-guard-ui");
    host.setAttribute("data-prompt-guard", "");
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.append(el("style", {}, CSS));
    document.documentElement.append(host);
    return { host, shadow, remove: () => host.remove() };
  }

  // Render text with placeholders highlighted.
  function previewNode(text) {
    const div = el("div", { class: "preview" });
    const parts = text.split(/(\[[A-Z_]+_\d+\])/g);
    for (const part of parts) {
      if (/^\[[A-Z_]+_\d+\]$/.test(part)) div.append(el("span", { class: "ph" }, part));
      else div.append(part);
    }
    return div;
  }

  // Show a short window of text around the first placeholder.
  function snippet(text, max) {
    const limit = max || 320;
    if (text.length <= limit) return text;
    const i = Math.max(0, text.search(/\[[A-Z_]+_\d+\]/));
    const start = Math.max(0, i - limit / 3);
    return (start > 0 ? "…" : "") + text.slice(start, start + limit) + (start + limit < text.length ? "…" : "");
  }

  function trapKeys(shadow, onEscape) {
    shadow.addEventListener("keydown", (e) => {
      e.stopPropagation(); // keep keystrokes away from the site's editor
      if (e.key === "Escape") onEscape();
    });
  }

  // opts: { counts, warnTypes, sendText, snoozeHours, allowFalsePositive, override: {enabled, require_justification} }
  function warn(opts) {
    return new Promise((resolve) => {
      const ui = mount();
      const result = { decision: "cancelled", snooze: false, falsePositive: [], justification: "" };
      const finish = (decision) => { result.decision = decision; ui.remove(); resolve(result); };

      const list = el("ul", {});
      for (const [type, n] of Object.entries(opts.counts)) list.append(el("li", {}, describe(type, n)));

      const snooze = opts.snoozeHours
        ? el("label", {}, el("input", { type: "checkbox", onchange: (e) => { result.snooze = e.target.checked; } }),
          `Don't warn me again about this for ${opts.snoozeHours} hours (still redacted)`)
        : null;

      const links = el("div", { class: "links" });
      if (opts.allowFalsePositive) {
        const fp = el("button", { class: "link", type: "button" }, "Not sensitive? Report a false positive");
        fp.addEventListener("click", () => {
          result.falsePositive = opts.warnTypes.slice();
          fp.replaceWith(el("span", { class: "muted" }, "Thanks, reported to your admin. The data will still be redacted."));
        });
        links.append(fp);
      }

      let overrideBox = null;
      if (opts.override && opts.override.enabled) {
        const ov = el("button", { class: "link", type: "button" }, "Send original instead…");
        ov.addEventListener("click", () => {
          const ta = el("textarea", { rows: "2", placeholder: "Reason for sending unredacted data (logged)" });
          const go = el("button", { class: "danger", type: "button" }, "Send original");
          go.addEventListener("click", () => {
            if (opts.override.require_justification && ta.value.trim().length < 5) { ta.focus(); return; }
            result.justification = ta.value.trim();
            finish("override");
          });
          overrideBox = el("div", {}, ta, el("div", { class: "row" }, go));
          ov.replaceWith(el("span", { class: "muted" }, "This will be logged and your admin alerted."));
          links.after(overrideBox);
          ta.focus();
        });
        links.append(ov);
      }

      const accept = el("button", { class: "primary", type: "button", onclick: () => finish("accepted") }, "Accept & send redacted");
      const cancel = el("button", { type: "button", onclick: () => finish("cancelled") }, "Cancel & edit");

      const dialog = el("div", { class: "dialog", role: "alertdialog", "aria-modal": "true", "aria-labelledby": "pg-title" },
        el("h2", { id: "pg-title" }, "⚠ Sensitive information detected"),
        el("p", {}, "Your prompt contains:"),
        list,
        el("p", { class: "muted" }, "Company policy: these will be replaced with placeholders before sending. This is what will be sent:"),
        previewNode(snippet(opts.sendText)),
        snooze,
        links,
        el("div", { class: "row" }, cancel, accept));

      ui.shadow.append(el("div", { class: "backdrop" }, dialog));
      trapKeys(ui.shadow, () => finish("cancelled"));
      accept.focus();
    });
  }

  // opts: { counts, blockTypes, bulk }
  function block(opts) {
    return new Promise((resolve) => {
      const ui = mount();
      const done = () => { ui.remove(); resolve(); };
      const list = el("ul", {});
      for (const t of opts.blockTypes) list.append(el("li", {}, describe(t, opts.counts[t] || 1)));
      const reason = opts.bulk
        ? el("p", {}, "This prompt contains a large amount of sensitive data, which looks like a data export. It can't be sent to an AI tool.")
        : el("p", {}, "This prompt contains data that company policy doesn't allow to be sent to AI tools:");
      const ok = el("button", { class: "primary", type: "button", onclick: done }, "Back to editing");
      ui.shadow.append(el("div", { class: "backdrop block" },
        el("div", { class: "dialog", role: "alertdialog", "aria-modal": "true" },
          el("h2", {}, "⛔ Not sent"),
          reason,
          opts.bulk ? null : list,
          el("p", { class: "muted" }, "Remove it from your prompt and try again. Nothing was sent."),
          el("div", { class: "row" }, ok))));
      trapKeys(ui.shadow, done);
      ok.focus();
    });
  }

  function error(message) {
    return new Promise((resolve) => {
      const ui = mount();
      const done = () => { ui.remove(); resolve(); };
      const ok = el("button", { class: "primary", type: "button", onclick: done }, "OK");
      ui.shadow.append(el("div", { class: "backdrop block" },
        el("div", { class: "dialog", role: "alertdialog", "aria-modal": "true" },
          el("h2", {}, "⛔ Not sent"), el("p", {}, message), el("div", { class: "row" }, ok))));
      trapKeys(ui.shadow, done);
      ok.focus();
    });
  }

  // Informational dialog (e.g. file uploads turned off). One OK button.
  function notice(title, message) {
    return new Promise((resolve) => {
      const ui = mount();
      const done = () => { ui.remove(); resolve(); };
      const ok = el("button", { class: "primary", type: "button", onclick: done }, "OK");
      ui.shadow.append(el("div", { class: "backdrop" },
        el("div", { class: "dialog", role: "alertdialog", "aria-modal": "true" },
          el("h2", {}, title), el("p", {}, message), el("div", { class: "row" }, ok))));
      trapKeys(ui.shadow, done);
      ok.focus();
    });
  }

  function toast(text) {
    const ui = mount();
    ui.shadow.append(el("div", { class: "toast", role: "status" }, text));
    setTimeout(ui.remove, 3500);
  }

  function summary(counts) {
    return Object.entries(counts).map(([t, n]) => describe(t, n)).join(", ");
  }

  root.PG = root.PG || {};
  root.PG.ui = { warn, block, error, notice, toast, summary, describe };
})(globalThis);
