// Mock of logged-out ChatGPT (2026-10-07): a React-controlled <textarea> in a
// form. Crucially, it SENDS FROM REACT STATE, not from the DOM, so if the
// extension changes the visible text without React noticing, the original
// (unredacted) text would be sent. The tests must catch that.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";

window.__sent = [];

function Composer() {
  const [value, setValue] = useState("");
  const send = () => {
    if (!value.trim()) return;
    window.__sent.push({ text: value });
    setValue("");
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); send(); }}>
      <textarea
        id="mobile-composer-prompt" name="prompt" aria-label="Chat with ChatGPT"
        value={value} onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.form.requestSubmit(); } }}
      />
      <button type="submit" aria-label="Send message">Send</button>
    </form>
  );
}

window.__promptText = () => document.querySelector("textarea[name=prompt]").value;
createRoot(document.getElementById("root")).render(<Composer />);
