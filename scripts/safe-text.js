// Make untrusted text safe to print in a terminal. Prompts are written by
// users, so they can contain escape sequences that rewrite or hide terminal
// output (or worse, in some terminals). Control characters are shown as
// visible placeholders instead; newlines and tabs are kept.
function safeText(s) {
  return String(s == null ? "" : s)
    // C0 controls (except \t \n), DEL, C1 controls, bidi overrides/isolates
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, (c) =>
      `\\u{${c.codePointAt(0).toString(16)}}`);
}
module.exports = { safeText };
