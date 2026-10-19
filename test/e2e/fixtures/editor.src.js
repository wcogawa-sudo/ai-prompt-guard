// Mock AI chat composer built on real ProseMirror (what ChatGPT and Claude use).
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { schema } from "prosemirror-schema-basic";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, chainCommands, createParagraphNear, liftEmptyBlock, splitBlock } from "prosemirror-commands";

window.__sent = [];
window.__attachments = [];

const attrs = JSON.parse(document.body.dataset.editorAttrs || "{}");
let view;

function promptText() {
  return view.state.doc.textBetween(0, view.state.doc.content.size, "\n");
}

function send() {
  const text = promptText();
  if (!text.trim() && !window.__pendingAttachments) return true;
  window.__sent.push({ text, attachments: window.__pendingAttachments || [] });
  window.__pendingAttachments = null;
  view.dispatch(view.state.tr.delete(0, view.state.doc.content.size));
  return true;
}
window.__send = send;

view = new EditorView(document.querySelector("#mount"), {
  state: EditorState.create({
    schema,
    plugins: [
      keymap({ Enter: () => send(), "Shift-Enter": chainCommands(createParagraphNear, liftEmptyBlock, splitBlock) }),
      keymap(baseKeymap),
    ],
  }),
  attributes: attrs,
  // Like ChatGPT/Claude: big pastes become an attachment instead of editor text.
  handlePaste(v, event) {
    const cd = event.clipboardData;
    if (cd && cd.files && cd.files.length) {
      for (const f of cd.files) (window.__files = window.__files || []).push(f.name);
      return true;
    }
    const text = event.clipboardData && event.clipboardData.getData("text/plain");
    if (text && text.length > 2000) {
      window.__attachments.push(text);
      window.__pendingAttachments = (window.__pendingAttachments || []).concat([text]);
      return true;
    }
    return false;
  },
});
window.__view = view;
window.__promptText = promptText;

document.querySelector("#send").addEventListener("click", () => send());
