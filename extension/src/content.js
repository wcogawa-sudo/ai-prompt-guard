// Content script: intercepts prompt sends and pastes on supported AI sites,
// applies policy, shows warnings, rewrites the prompt with placeholders and
// lets it through. Runs at document_start so our capture-phase listeners fire
// before the site's own handlers.

(function () {
  "use strict";

  const { detectors, policy: P, adapters, ui, netscan: NS } = globalThis.PG;
  const adapter = adapters.forLocation(location);
  if (!adapter) return;

  const state = {
    policy: null,
    group: null,
    snoozes: {},           // type -> epoch ms until which warnings are snoozed
    busy: false,           // a dialog is open or a send is in flight
    placeholders: new Map(), // conversation id -> Placeholders (memory only, never stored)
    lastConversation: null,
    reportedDegraded: false,
    active: false,         // false outside work (scope): extension is fully dormant
  };

  // ---------- config ----------

  function applyEffective(eff) {
    if (!eff) return;
    state.policy = eff.policy;
    state.group = eff.group || null;
    publishFilesFlag();
  }

  // ---------- file upload policy ----------
  // policy.files.action: "allow" (default) | "log_only" | "block".
  // A group can override it with groups[<group>].FILE_UPLOAD.
  function filesPolicy() {
    if (!state.active) return { action: "allow", alertSoc: false, message: null };
    const f = (state.policy && state.policy.files) || {};
    let action = f.action || "allow";
    const g = state.policy && state.group && state.policy.groups && state.policy.groups[state.group];
    if (g && g.FILE_UPLOAD) action = g.FILE_UPLOAD;
    return { action, alertSoc: !!f.alert_soc, message: f.message || null };
  }

  // The page-world script (page-files.js) blocks programmatic file pickers;
  // it reads the current action from this attribute.
  function publishFilesFlag() {
    if (document.documentElement) document.documentElement.dataset.pgFiles = filesPolicy().action;
  }

  function applyScope(sc) {
    state.active = !!(sc && sc.active);
    publishFilesFlag();
  }

  chrome.storage.local.get(["effective", "snoozes", "scopeState"], (r) => {
    applyEffective(r.effective);
    applyScope(r.scopeState);
    state.snoozes = r.snoozes || {};
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.effective) applyEffective(changes.effective.newValue);
    if (changes.scopeState) applyScope(changes.scopeState.newValue);
    if (changes.snoozes) state.snoozes = changes.snoozes.newValue || {};
  });

  function snoozedTypes() {
    const now = Date.now();
    return new Set(Object.entries(state.snoozes).filter(([, until]) => until > now).map(([t]) => t));
  }

  function snooze(types, hours) {
    const until = Date.now() + hours * 3600 * 1000;
    const next = { ...state.snoozes };
    for (const t of types) next[t] = until;
    state.snoozes = next;
    chrome.storage.local.set({ snoozes: next });
  }

  // Same placeholders for the whole conversation. A brand-new chat has no id
  // until the first message is sent, so carry its mapping over to the new id.
  function placeholdersForConversation() {
    const id = adapter.conversationId();
    let ph = state.placeholders.get(id);
    if (!ph && state.lastConversation === "new" && id !== "new" && state.placeholders.has("new")) {
      ph = state.placeholders.get("new");
      state.placeholders.delete("new");
      state.placeholders.set(id, ph);
    }
    if (!ph) {
      ph = new P.Placeholders();
      state.placeholders.set(id, ph);
    }
    state.lastConversation = id;
    return ph;
  }

  // ---------- logging ----------

  async function sha256(s) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  }

  // `evidence` (optional) holds the original text and values. It is handed to
  // the background worker, which encrypts it with the org's public key before
  // anything is stored or uploaded. It is never written anywhere in plain text.
  async function log(fields, evidence) {
    if (!state.active) return;
    const event = {
      "@timestamp": new Date().toISOString(),
      "ai.site": location.hostname,
      "ai.adapter": adapter.name,
      "ai.adapter_degraded": adapter.degraded,
      "ai.conversation_hash": await sha256(location.hostname + adapter.conversationId()),
      "policy.version": state.policy ? state.policy.version : null,
      layer: "dom",
      ...fields,
    };
    try {
      chrome.runtime.sendMessage({ type: "log", event, evidence: evidence || null });
    } catch (_) {
      // Extension was reloaded/updated; this page's script is orphaned.
    }
  }

  // Original text + placeholder -> value mapping for the encrypted evidence store.
  function evidenceFor(text, decision, ph, extra) {
    const items = decision.items.filter((i) => i.action !== "allow");
    if (!items.length) return null;
    return {
      original_text: text,
      values: items.map((i) => ({ placeholder: ph.tokenFor(i.type, i.value), type: i.type, value: i.value })),
      ...extra,
    };
  }

  function detectionSummary(decision) {
    return Object.entries(decision.counts).map(([type, count]) => ({ type, count }));
  }

  // Redact a free-text field (e.g. an override justification) before logging it.
  function redactForLog(text) {
    const d = P.evaluate(detectors.detect(text), state.policy, {});
    return P.textToLog(text, d, new P.Placeholders());
  }

  // ---------- editor manipulation ----------

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const norm = (s) => s.replace(/\s+/g, " ").trim();

  function selectAll(editor) {
    editor.focus();
    if (editor.tagName === "TEXTAREA") {
      editor.select();
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(editor);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function syntheticPaste(editor, text) {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    editor.dispatchEvent(ev);
    return ev.defaultPrevented; // true = the editor handled it
  }

  function setTextareaValue(ta, text) {
    // Use the native setter so React-controlled textareas notice the change.
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // Replace the whole prompt with `text`, then verify the editor really holds
  // it. Rich editors (ProseMirror) don't take plain .value assignment, so try
  // insertText first, then a synthetic paste. Never send if verification fails.
  async function rewriteEditor(editor, text) {
    if (editor.tagName === "TEXTAREA") {
      setTextareaValue(editor, text);
      await nextFrame();
      return norm(editor.value) === norm(text);
    }
    const attempts = [
      () => { selectAll(editor); document.execCommand("insertText", false, text); },
      () => { selectAll(editor); if (!syntheticPaste(editor, text)) document.execCommand("insertText", false, text); },
    ];
    for (const attempt of attempts) {
      attempt();
      await nextFrame();
      await nextFrame();
      if (norm(adapter.getText(editor)) === norm(text)) return true;
    }
    return false;
  }

  // Remember where the caret was when the user pasted. A dialog takes focus
  // away, and the editor may forget its caret position meanwhile.
  function saveCaret(editor) {
    if (editor.tagName === "TEXTAREA") return { start: editor.selectionStart, end: editor.selectionEnd };
    const sel = window.getSelection();
    return { range: sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null };
  }

  // Insert text at a saved caret position (used for paste-time redaction).
  async function insertAt(editor, text, caret) {
    editor.focus();
    if (editor.tagName === "TEXTAREA") {
      const v = editor.value;
      const start = caret ? Math.min(caret.start, v.length) : v.length;
      const end = caret ? Math.min(caret.end, v.length) : v.length;
      setTextareaValue(editor, v.slice(0, start) + text + v.slice(end));
      editor.setSelectionRange(start + text.length, start + text.length);
      return;
    }
    if (caret && caret.range) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(caret.range);
    }
    if (!syntheticPaste(editor, text)) document.execCommand("insertText", false, text);
    await nextFrame();
  }

  // Trigger the site's own send. Our listeners ignore untrusted events, so
  // this programmatic click/keypress passes straight through.
  async function triggerSend(editor) {
    for (let i = 0; i < 20; i++) {
      await nextFrame();
      const btn = adapter.findSendButton();
      if (btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
        btn.click();
        return true;
      }
    }
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
    return true;
  }

  // ---------- core flow ----------

  function decide(text) {
    const dets = detectors.detect(text, { keywords: P.allKeywords(state.policy), people: state.policy.people });
    return P.evaluate(dets, state.policy, { group: state.group, snoozedTypes: snoozedTypes() });
  }

  function reportDegradedOnce() {
    if (adapter.degraded && !state.reportedDegraded) {
      state.reportedDegraded = true;
      log({ "event.action": "adapter_degraded" });
    }
  }

  // Called synchronously from the capture listener. Returns true if the
  // event must be stopped (we take over and send later ourselves).
  // opts.stage: "send" (main chat box) or "edit" (any other text box: edited
  // message, custom instructions...). opts.submit: how to submit afterwards.
  function onSendAttempt(editor, opts) {
    const o = opts || {};
    if (state.busy) return true;
    if (!state.policy) return false; // config not loaded yet: fail open, nothing to enforce against
    if (!state.active) return false; // outside work: not monitored
    reportDegradedOnce();

    const text = adapter.getText(editor);
    if (!text.trim()) return false;

    const decision = decide(text);
    const ph = placeholdersForConversation();
    const base = {
      stage: o.stage || "send",
      "prompt.length": text.length,
      detections: detectionSummary(decision),
      "policy.action": decision.action,
    };

    if (decision.action === "allow" || decision.action === "log_only") {
      log({ ...base, "event.action": "prompt_sent", "user.decision": "none", "prompt.redacted": P.textToLog(text, decision, ph) },
        evidenceFor(text, decision, ph));
      return false; // let the site send normally, zero friction
    }

    state.busy = true;
    handleSensitiveSend(editor, text, decision, ph, base, o.submit || (() => triggerSend(editor))).finally(() => { state.busy = false; });
    return true;
  }

  async function handleSensitiveSend(editor, text, decision, ph, base, submit) {
    const sendText = P.textToSend(text, decision, ph);
    const logText = P.textToLog(text, decision, ph);
    const evidence = evidenceFor(text, decision, ph);

    if (decision.action === "block") {
      log({ ...base, "event.action": "prompt_blocked", "user.decision": "none", "prompt.redacted": logText,
        "alert.soc": decision.alertSoc, bulk: decision.bulk }, evidence);
      await ui.block({ counts: decision.counts, blockTypes: decision.blockTypes, bulk: decision.bulk });
      editor.focus();
      return;
    }

    let userDecision = "none";
    let justification = "";
    if (decision.action === "redact_warn") {
      const res = await ui.warn({
        counts: decision.counts,
        warnTypes: decision.warnTypes,
        sendText,
        snoozeHours: state.policy.warning && state.policy.warning.snooze_hours,
        allowFalsePositive: state.policy.warning && state.policy.warning.allow_false_positive_report,
        override: state.policy.override_unredacted,
      });
      if (res.falsePositive.length) {
        log({ ...base, "event.action": "false_positive_report", "false_positive.types": res.falsePositive, "prompt.redacted": logText }, evidence);
      }
      if (res.snooze) snooze(decision.warnTypes, state.policy.warning.snooze_hours);
      userDecision = res.decision;
      justification = res.justification;
      if (res.decision === "cancelled") {
        log({ ...base, "event.action": "prompt_cancelled", "user.decision": "cancelled", "prompt.redacted": logText }, evidence);
        editor.focus();
        return;
      }
    }

    if (userDecision === "override") {
      allowOnNetwork(decision);
      log({ ...base, "event.action": "prompt_sent_unredacted", "user.decision": "override",
        "override.justification": redactForLog(justification), "prompt.redacted": logText,
        "alert.soc": !!state.policy.override_unredacted.alert_soc }, evidenceFor(text, decision, ph, { justification }));
      await submit();
      return;
    }

    const ok = await rewriteEditor(editor, sendText);
    if (!ok) {
      log({ ...base, "event.action": "redaction_failed", "user.decision": userDecision, "prompt.redacted": logText, "alert.soc": false }, evidence);
      await ui.error("Prompt Guard couldn't apply the redaction on this page, so your message was not sent. Please remove the sensitive information manually.");
      return;
    }
    await submit();
    log({ ...base, "event.action": "prompt_sent_redacted", "user.decision": userDecision === "none" ? "silent" : userDecision,
      "prompt.redacted": logText }, evidence);
    if (decision.action === "redact_silent") ui.toast(`🔒 Protected: ${ui.summary(decision.counts)}`);
  }

  // Paste-time check: catches large pastes before the site turns them into an
  // attachment the send-time check can't read.
  function onPaste(e, editor) {
    if (!state.policy || !state.active) return;
    const cd = e.clipboardData;
    if (!cd || cd.files.length) return; // file pastes: out of scope for v0.1
    const text = cd.getData("text/plain");
    if (!text) return;

    const decision = decide(text);
    if (decision.action === "allow" || decision.action === "log_only") return;

    e.preventDefault();
    e.stopImmediatePropagation();
    if (state.busy) return;
    state.busy = true;

    const caret = saveCaret(editor);
    handleSensitivePaste(editor, text, decision, caret).finally(() => { state.busy = false; });
  }

  async function handleSensitivePaste(editor, text, decision, caret) {
    const ph = placeholdersForConversation();
    const sendText = P.textToSend(text, decision, ph);
    const base = {
      stage: "paste",
      "prompt.length": text.length,
      detections: detectionSummary(decision),
      "policy.action": decision.action,
      "prompt.redacted": P.textToLog(text, decision, ph),
    };
    const evidence = evidenceFor(text, decision, ph);

    if (decision.action === "block") {
      log({ ...base, "event.action": "paste_blocked", "user.decision": "none", "alert.soc": decision.alertSoc, bulk: decision.bulk }, evidence);
      await ui.block({ counts: decision.counts, blockTypes: decision.blockTypes, bulk: decision.bulk });
      editor.focus();
      return;
    }

    if (decision.action === "redact_silent") {
      await insertAt(editor, sendText, caret);
      state.busy = false; // ready for the next keystroke immediately
      log({ ...base, "event.action": "paste_redacted", "user.decision": "silent" }, evidence);
      ui.toast(`🔒 Protected: ${ui.summary(decision.counts)}`);
      return;
    }

    const res = await ui.warn({
      counts: decision.counts,
      warnTypes: decision.warnTypes,
      sendText,
      snoozeHours: state.policy.warning && state.policy.warning.snooze_hours,
      allowFalsePositive: state.policy.warning && state.policy.warning.allow_false_positive_report,
      override: state.policy.override_unredacted,
    });
    if (res.falsePositive.length) log({ ...base, "event.action": "false_positive_report", "false_positive.types": res.falsePositive }, evidence);
    if (res.snooze) snooze(decision.warnTypes, state.policy.warning.snooze_hours);

    if (res.decision === "accepted") {
      await insertAt(editor, sendText, caret);
      state.busy = false; // ready for the next keystroke immediately
      log({ ...base, "event.action": "paste_redacted", "user.decision": "accepted" }, evidence);
    } else if (res.decision === "override") {
      allowOnNetwork(decision);
      await insertAt(editor, text, caret);
      state.busy = false;
      log({ ...base, "event.action": "paste_unredacted", "user.decision": "override",
        "override.justification": redactForLog(res.justification), "alert.soc": !!state.policy.override_unredacted.alert_soc },
        evidenceFor(text, decision, ph, { justification: res.justification }));
    } else {
      log({ ...base, "event.action": "paste_cancelled", "user.decision": "cancelled" }, evidence);
      editor.focus();
    }
  }

  // ---------- other text boxes (edit message, custom instructions, ...) ----------
  // Anything typed into the AI site is sent to the AI company, not just the
  // main chat box. Editing an earlier message was a bypass: the edit box is a
  // separate text box with its own Send/Save button.

  const EDITABLE = 'textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]';
  const SUBMIT_WORDS = /\b(send|save|submit|update|resend|apply)\b/i;

  function secondaryEditable(el) {
    if (!el || !el.closest || adapter.isEditor(el)) return null;
    const ed = el.closest(EDITABLE);
    return ed && !adapter.isEditor(ed) ? ed : null;
  }

  function buttonLabel(b) {
    return `${b.getAttribute("aria-label") || ""} ${b.getAttribute("title") || ""} ${b.textContent || ""}`.trim();
  }
  function isSubmitButton(b) {
    if (!b || b.tagName !== "BUTTON" || b.disabled) return false;
    const label = buttonLabel(b);
    return SUBMIT_WORDS.test(label) && !/cancel|discard|close/i.test(label);
  }

  // Nearest Send/Save-style button around a text box (walks up a few levels).
  function findSubmitFor(editor) {
    // Stop before <body>: otherwise any Save button anywhere on the page would match.
    let node = editor.parentElement;
    for (let depth = 0; node && node !== document.body && depth < 8; depth++, node = node.parentElement) {
      const b = [...node.querySelectorAll("button")].find((x) => isSubmitButton(x) && !adapter.isSendButton(x));
      if (b) return b;
    }
    return null;
  }

  // Text boxes (other than the main chat box) that a Send/Save button submits.
  function editablesFor(button) {
    let node = button.parentElement;
    for (let depth = 0; node && node !== document.body && depth < 8; depth++, node = node.parentElement) {
      const eds = [...node.querySelectorAll(EDITABLE)].filter((ed) => !adapter.isEditor(ed) && adapter.getText(ed).trim());
      if (eds.length) return eds;
    }
    return [];
  }

  // ---------- listeners (capture phase on window = first to see events) ----------

  function stop(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    e.stopPropagation();
  }

  window.addEventListener("keydown", (e) => {
    if (!e.isTrusted || e.key !== "Enter" || e.shiftKey || e.isComposing || e.altKey) return;
    if (adapter.isEditor(e.target)) {
      if (onSendAttempt(adapter.editorFor(e.target))) stop(e);
      return;
    }
    // Another text box with its own Send/Save button (e.g. editing a message).
    const ed = secondaryEditable(e.target);
    if (ed && findSubmitFor(ed)) {
      // After redaction, replay the Enter so the site does whatever Enter does there.
      const replay = async () => {
        await nextFrame();
        ed.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
      };
      if (onSendAttempt(ed, { stage: "edit", submit: replay })) stop(e);
    }
  }, true);

  // pointerdown/mousedown too: some sites send on mousedown rather than click.
  for (const type of ["click", "pointerdown", "mousedown"]) {
    window.addEventListener(type, (e) => {
      if (!e.isTrusted) return;
      const btn = adapter.isSendButton(e.target);
      if (!btn) {
        const b = e.target && e.target.closest && e.target.closest("button");
        if (!b || !isSubmitButton(b)) return;
        if (type !== "click") { if (state.busy) stop(e); return; }
        for (const ed of editablesFor(b)) {
          const submit = async () => { await nextFrame(); b.click(); };
          if (onSendAttempt(ed, { stage: "edit", submit })) { stop(e); return; }
        }
        return;
      }
      if (type !== "click") {
        // Only block the early events while we're handling a send; the
        // decision itself is made once, on click.
        if (state.busy) stop(e);
        return;
      }
      const editor = adapter.findEditor();
      if (editor && onSendAttempt(editor)) stop(e);
    }, true);
  }

  window.addEventListener("paste", (e) => {
    const cd = e.clipboardData;
    if (state.policy && state.active && cd && cd.files && cd.files.length) {
      const fp = filesPolicy();
      if (fp.action === "block") {
        stop(e);
        const text = cd.getData("text/plain");
        onFilesBlocked("paste", [...cd.files]);
        // Keep any text that came with the file (e.g. copied from Office).
        if (text && adapter.isEditor(e.target)) pasteTextOnly(adapter.editorFor(e.target), text);
        return;
      }
      if (fp.action === "log_only") logFilesAttached("paste", [...cd.files]);
    }
    if (!e.isTrusted) return;
    if (adapter.isEditor(e.target)) { onPaste(e, adapter.editorFor(e.target)); return; }
    const ed = secondaryEditable(e.target);
    if (ed) onPaste(e, ed);
  }, true);

  // ---------- file uploads ----------
  // Four ways a file reaches the AI: the file picker (attach button), the file
  // input's change event, drag-and-drop, and pasting a file/screenshot. The
  // picker opened from site code (input.click()) is handled by page-files.js
  // in the page's own world; everything else is handled here.

  function fileMeta(files) {
    const list = files || [];
    const exts = [...new Set(list.map((f) => (f.name.includes(".") ? f.name.split(".").pop().toLowerCase() : f.type || "unknown")))];
    return {
      "file.count": list.length,
      "file.extensions": exts,
      "file.total_size": list.reduce((n, f) => n + (f.size || 0), 0),
      // File names can contain PII ("Thabo_Nkosi_payslip.pdf"), so redact them.
      "file.names_redacted": list.map((f) => redactForLog(f.name)),
    };
  }

  let lastNotice = 0;
  function onFilesBlocked(method, files) {
    const fp = filesPolicy();
    log({ "event.action": "file_blocked", "file.method": method, ...(files ? fileMeta(files) : {}), "alert.soc": fp.alertSoc });
    if (Date.now() - lastNotice < 1500) return; // one notice per attempt (picker + change can both fire)
    lastNotice = Date.now();
    ui.notice("📎 File uploads are turned off",
      fp.message || "Your organisation doesn't allow uploading files to AI tools. Copy the text you need into the chat instead. Sensitive details in it are still protected automatically.");
  }

  function logFilesAttached(method, files) {
    log({ "event.action": "file_attached", "file.method": method, ...fileMeta(files) });
  }

  async function pasteTextOnly(editor, text) {
    const caret = saveCaret(editor);
    const decision = decide(text);
    if (decision.action === "allow" || decision.action === "log_only") {
      await insertAt(editor, text, caret);
      return;
    }
    if (state.busy) return;
    state.busy = true;
    handleSensitivePaste(editor, text, decision, caret).finally(() => { state.busy = false; });
  }

  // Signal from page-files.js: site code tried to open the file picker.
  // Also carries {attached: [...]} metadata in log_only mode for site-code pickers.
  document.addEventListener("pg-file-blocked", (e) => {
    const d = String(e.detail || "picker");
    if (d.startsWith("{")) {
      try {
        const files = JSON.parse(d).attached || [];
        if (files.length && filesPolicy().action === "log_only") logFilesAttached("picker", files);
      } catch (_) { /* ignore malformed */ }
      return;
    }
    onFilesBlocked(d, null);
  });

  const isFileInput = (el) => el && el.tagName === "INPUT" && el.type === "file";

  // A real click on a (possibly invisible) file input, or a <label> for one.
  window.addEventListener("click", (e) => {
    if (!state.policy || filesPolicy().action !== "block") return;
    const t = e.target;
    const input = isFileInput(t) ? t : (t && t.closest && t.closest("label") && t.closest("label").control);
    if (isFileInput(input)) {
      stop(e);
      onFilesBlocked("picker", null);
    }
  }, true);

  // Backstop: files got selected anyway. Discard them before the site sees them.
  window.addEventListener("change", (e) => {
    const t = e.target;
    if (!state.policy || !isFileInput(t) || !t.files || !t.files.length) return;
    const fp = filesPolicy();
    if (fp.action === "block") {
      stop(e);
      const files = [...t.files];
      t.value = "";
      onFilesBlocked("change", files);
    }
    // log_only is reported by page-files.js when the picker was opened by site
    // code; a direct click on a visible input is logged here.
    else if (fp.action === "log_only" && t.dataset.pgDirect === "1") {
      logFilesAttached("picker", [...t.files]);
    }
  }, true);

  window.addEventListener("drop", (e) => {
    const dt = e.dataTransfer;
    if (!state.policy || !dt || !dt.files || !dt.files.length) return;
    const fp = filesPolicy();
    if (fp.action === "block") {
      stop(e);
      onFilesBlocked("drop", [...dt.files]);
    } else if (fp.action === "log_only") {
      logFilesAttached("drop", [...dt.files]);
    }
  }, true);

  // Text dropped into the editor bypasses paste; v0.1 just scans it at send time.

  // ---------- network safety net ----------
  // page-net.js (page world) hands us every outgoing text body before it
  // leaves. Normally the page-level check has already redacted the prompt, so
  // nothing is found. A hit means something bypassed it: we redact it in
  // flight (or block, per policy) and alert the SOC.

  // Values the user deliberately chose to send unredacted (override with a
  // justification) are let through for a while, so this layer doesn't
  // silently undo their decision.
  const NET_ALLOW_MS = 15 * 60 * 1000;
  const netAllow = new Map(); // type + "\0" + normalized value -> expiry
  function allowOnNetwork(decision) {
    const until = Date.now() + NET_ALLOW_MS;
    for (const i of decision.items) if (i.action !== "allow") netAllow.set(i.type + "\u0000" + NS.normalize(i.type, i.value), until);
  }
  function netAllowValues() {
    const now = Date.now();
    for (const [k, until] of netAllow) if (until <= now) netAllow.delete(k);
    return new Set(netAllow.keys());
  }

  // At most 30 network events a minute: a misbehaving page can't flood the SOC.
  let netLogTimes = [];
  function netLogAllowed() {
    const now = Date.now();
    netLogTimes = netLogTimes.filter((t) => now - t < 60000);
    if (netLogTimes.length >= 30) return false;
    netLogTimes.push(now);
    return true;
  }

  function netPolicy() {
    const n = (state.policy && state.policy.network) || {};
    return { enabled: n.enabled !== false, action: n.action || "redact", types: n.types, alertSoc: n.alert_soc !== false };
  }

  function urlPath(u) {
    try { return new URL(u, location.href).pathname.slice(0, 200); } catch (_) { return ""; }
  }

  function onNetCheck(e) {
    if (typeof e.detail !== "string" || e.detail.length > NS.MAX_BODY * 2) return;
    let req;
    try { req = JSON.parse(e.detail); } catch (_) { return; }
    if (!req || typeof req.id !== "string" || typeof req.body !== "string") return;
    // No answer = pass. Outside work or before config loads we stay out of the way.
    if (!state.policy || !state.active) return;
    const np = netPolicy();
    if (!np.enabled) return;

    const ph = placeholdersForConversation();
    let res;
    try {
      res = NS.scan(req.body, {
      detect: (t) => detectors.detect(t),
      types: np.types,
      allowValues: netAllowValues(),
      tokenFor: (t, v) => ph.tokenFor(t, v),
      ruleAction: (d) => {
        const dec = P.evaluate([d], state.policy, { group: state.group });
        return dec.items.length ? dec.items[0].action : "allow";
      },
      });
    } catch (err) {
      // Never break the site over a scanner bug: let it through, but make the gap visible.
      if (netLogAllowed()) log({ layer: "network", "event.action": "network_scan_error", "net.path": urlPath(req.url), "error.message": String(err && err.message).slice(0, 200) });
      return;
    }
    if (!res.hits.length) return;

    const reply = (r) => document.dispatchEvent(new CustomEvent("pg-net-result", { detail: JSON.stringify({ id: req.id, ...r }) }));
    const enforce = res.enforce.length > 0;
    const block = enforce && (np.action === "block" || res.enforce.some((h) => h.action === "block") || !res.verified);
    let action = "network_detected";
    if (enforce && block) { reply({ action: "block" }); action = "network_blocked"; }
    else if (enforce && np.action !== "log_only") { reply({ action: "replace", body: res.body }); action = "network_redacted"; }

    const counts = {};
    for (const h of res.hits) counts[h.type] = (counts[h.type] || 0) + 1;
    if (netLogAllowed()) {
      log({
        layer: "network",
        "event.action": action,
        "net.kind": String(req.kind || "").slice(0, 20),
        "net.path": urlPath(req.url),
        "net.verified": res.verified,
        detections: Object.entries(counts).map(([type, count]) => ({ type, count })),
        "alert.soc": enforce && np.alertSoc,
      }, {
        original_text: `[${req.kind} ${urlPath(req.url)}]`,
        values: res.hits.map((h) => ({ placeholder: ph.tokenFor(h.type, h.value), type: h.type, value: h.value })),
      });
    }
    if (action === "network_redacted") ui.toast(`🔒 Protected: ${ui.summary(counts)}`);
    if (action === "network_blocked") {
      ui.notice("🛑 Request stopped", "This page tried to send sensitive data that couldn't be safely removed, so Prompt Guard stopped it. Please remove the sensitive details and try again.");
    }
  }
  document.addEventListener("pg-net-check", onNetCheck);
})();
