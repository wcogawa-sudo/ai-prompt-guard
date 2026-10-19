// Network safety net, page side. Runs in the PAGE's own JavaScript world
// (manifest "world": "MAIN") at document_start, before the site's scripts, so
// it wraps fetch / XMLHttpRequest / WebSocket / sendBeacon before the site
// grabs them.
//
// Every outgoing text body is handed to the extension's content script
// through a synchronous DOM event ("pg-net-check"); the content script answers
// with "pg-net-result": pass, a redacted body, or block. DOM event dispatch is
// synchronous across worlds, so this also works for the synchronous APIs
// (XHR.send, WebSocket.send, sendBeacon).
//
// No policy, detector or name list ever enters this world: the page only
// learns the verdict for its own data. If the content script isn't ready yet,
// there is no answer and the request passes (same as the page-level check
// before its config loads).
(() => {
  "use strict";

  // Keep our own references so later site code can't change how we talk to
  // the content script.
  const dispatch = EventTarget.prototype.dispatchEvent;
  const addListener = EventTarget.prototype.addEventListener;
  const CE = CustomEvent;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const doc = document;

  let seq = 0;
  const results = new Map();
  addListener.call(doc, "pg-net-result", (e) => {
    if (typeof e.detail !== "string") return;
    try {
      const r = parse(e.detail);
      if (r && typeof r.id === "string") results.set(r.id, r);
    } catch (_) { /* ignore */ }
  });

  // Returns { action: "pass" | "replace" | "block", body }
  function check(kind, url, body) {
    if (typeof body !== "string" || !body) return { action: "pass" };
    const id = "n" + (++seq) + "-" + Math.random().toString(36).slice(2);
    dispatch.call(doc, new CE("pg-net-check", { detail: stringify({ id, kind, url: String(url || ""), body }) }));
    const r = results.get(id);
    results.delete(id);
    if (!r) return { action: "pass" };
    if (r.action === "replace" && typeof r.body === "string") return { action: "replace", body: r.body };
    if (r.action === "block") return { action: "block" };
    return { action: "pass" };
  }

  const blockedError = () => new TypeError("Blocked by Prompt Guard: this request contained sensitive data your organisation doesn't allow to be sent to AI tools.");
  const SENDS_BODY = (m) => !/^(GET|HEAD)$/i.test(m || "GET");

  // URLSearchParams bodies are checked as text and rebuilt, so the
  // form-encoded content type is kept.
  function asText(body) {
    if (typeof body === "string") return { text: body, rebuild: (t) => t };
    if (body instanceof URLSearchParams) return { text: body.toString(), rebuild: (t) => new URLSearchParams(t) };
    return null; // Blob / FormData / ArrayBuffer / stream: files and binary, handled by the file policy
  }

  // ---------- fetch ----------
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = async function (input, init) {
      const isReq = typeof Request !== "undefined" && input instanceof Request;
      const method = (init && init.method) || (isReq ? input.method : "GET");
      const url = isReq ? input.url : String(input);
      if (!SENDS_BODY(method)) return origFetch.call(this, input, init);

      if (init && init.body != null) {
        const t = asText(init.body);
        if (t) {
          const r = check("fetch", url, t.text);
          if (r.action === "block") throw blockedError();
          if (r.action === "replace") init = { ...init, body: t.rebuild(r.body) };
        }
        return origFetch.call(this, input, init);
      }
      if (isReq && input.body) {
        let text;
        try { text = await input.clone().text(); } catch (_) { return origFetch.call(this, input, init); }
        const r = check("fetch", url, text);
        if (r.action === "block") throw blockedError();
        if (r.action === "replace") return origFetch.call(this, new Request(input, { body: r.body }), init);
      }
      return origFetch.call(this, input, init);
    };
  }

  // ---------- XMLHttpRequest ----------
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  const meta = new WeakMap();
  XHR.open = function (method, url, ...rest) {
    meta.set(this, { method: String(method || "GET"), url: String(url || "") });
    return origOpen.call(this, method, url, ...rest);
  };
  XHR.send = function (body) {
    const m = meta.get(this) || {};
    if (SENDS_BODY(m.method) && body != null) {
      const t = asText(body);
      if (t) {
        const r = check("xhr", m.url, t.text);
        if (r.action === "block") {
          this.abort();
          throw blockedError();
        }
        if (r.action === "replace") return origSend.call(this, t.rebuild(r.body));
      }
    }
    return origSend.call(this, body);
  };

  // ---------- WebSocket (text frames) ----------
  if (typeof WebSocket === "function") {
    const origWsSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string") {
        const r = check("websocket", this.url, data);
        if (r.action === "block") return; // drop the frame
        if (r.action === "replace") return origWsSend.call(this, r.body);
      }
      return origWsSend.call(this, data);
    };
  }

  // ---------- sendBeacon ----------
  if (navigator.sendBeacon) {
    const origBeacon = navigator.sendBeacon;
    navigator.sendBeacon = function (url, data) {
      const t = data != null ? asText(data) : null;
      if (t) {
        const r = check("beacon", url, t.text);
        if (r.action === "block") return false;
        if (r.action === "replace") return origBeacon.call(this, url, t.rebuild(r.body));
      }
      return origBeacon.call(this, url, data);
    };
  }
})();
