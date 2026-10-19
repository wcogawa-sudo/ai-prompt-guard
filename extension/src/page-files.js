// Runs in the PAGE's own JavaScript world (manifest "world": "MAIN"), because
// AI sites usually open the file picker from their own code with
// input.click() on an input that may not even be in the document. The
// extension's isolated world can't see that, so we wrap the APIs here.
// The current policy action is read from <html data-pg-files="...">, set by
// content.js. Blocking is signalled back with a "pg-file-blocked" event.
(() => {
  "use strict";
  const blocked = () => document.documentElement && document.documentElement.dataset.pgFiles === "block";
  const notify = (how) => document.dispatchEvent(new CustomEvent("pg-file-blocked", { detail: how }));

  const proto = HTMLInputElement.prototype;
  const origClick = proto.click;
  const mode = () => document.documentElement && document.documentElement.dataset.pgFiles;
  // In log_only mode, report what was picked (metadata only) once the user chooses.
  // Detail is a JSON string: objects don't cross from the page world to the extension.
  function watch(input) {
    if (mode() !== "log_only") return;
    input.addEventListener("change", () => {
      const files = [...(input.files || [])].map((f) => ({ name: f.name, size: f.size, type: f.type }));
      if (files.length) notify(JSON.stringify({ attached: files }));
    }, { once: true });
  }
  proto.click = function () {
    if (this.type === "file" && blocked()) { notify("picker"); return; }
    if (this.type === "file") watch(this);
    return origClick.call(this);
  };
  if (proto.showPicker) {
    const origShow = proto.showPicker;
    proto.showPicker = function () {
      if (this.type === "file" && blocked()) { notify("picker"); return; }
      if (this.type === "file") watch(this);
      return origShow.call(this);
    };
  }
  if (typeof window.showOpenFilePicker === "function") {
    const origOpen = window.showOpenFilePicker;
    window.showOpenFilePicker = function (...args) {
      if (blocked()) {
        notify("picker");
        return Promise.reject(new DOMException("File uploads are blocked by your organisation", "AbortError"));
      }
      return origOpen.apply(this, args);
    };
  }
})();
