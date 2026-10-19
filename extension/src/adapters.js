// Site adapters: how to find the prompt box and send button on each AI site.
// These selectors are the part that breaks when a site redesigns its UI, so
// each adapter also falls back to generic heuristics.

(function (root) {
  "use strict";

  const GENERIC_EDITOR = 'div[contenteditable="true"], textarea';
  const GENERIC_SEND = 'button[type="submit"], button[aria-label*="send" i], button[data-testid*="send" i]';

  const BLOCK_TAGS = new Set(["P", "DIV", "PRE", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "BLOCKQUOTE"]);

  const registry = [];

  function register(adapter) {
    registry.unshift(adapter); // later registrations take precedence
  }

  function firstMatch(selectors) {
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function makeAdapter(def) {
    return {
      ...def,
      degraded: false,
      findEditor() {
        const el = firstMatch(def.editorSelectors);
        if (el) return el;
        this.degraded = true;
        const active = document.activeElement;
        if (active && active.matches && active.matches(GENERIC_EDITOR)) return active;
        return document.querySelector(GENERIC_EDITOR);
      },
      // Generic matching is only used when the site's known prompt box is
      // missing (i.e. the site changed its UI); otherwise an Enter in some
      // unrelated text box (settings, search) would be treated as a send.
      knownEditorPresent() {
        return !!firstMatch(def.editorSelectors);
      },
      isEditor(el) {
        if (!el || !el.closest) return false;
        if (el.closest(def.editorSelectors.join(","))) return true;
        if (this.knownEditorPresent()) return false;
        if (el.closest(GENERIC_EDITOR)) { this.degraded = true; return true; }
        return false;
      },
      editorFor(el) {
        return el.closest(def.editorSelectors.join(",")) || el.closest(GENERIC_EDITOR);
      },
      findSendButton() {
        return firstMatch(def.sendSelectors) || firstMatch([GENERIC_SEND]);
      },
      isSendButton(el) {
        if (!el || !el.closest) return null;
        const known = el.closest(def.sendSelectors.join(","));
        if (known) return known;
        // Generic: a submit-ish button in the same form as an editor.
        const generic = el.closest(GENERIC_SEND);
        if (generic && !firstMatch(def.sendSelectors)) {
          const form = generic.closest("form");
          if (form && form.querySelector(GENERIC_EDITOR)) { this.degraded = true; return generic; }
        }
        return null;
      },
      getText(editor) {
        if (!editor) return "";
        if (editor.tagName === "TEXTAREA") return editor.value;
        // Rich editors put each line in its own block (<p>). innerText adds a
        // blank line between blocks, which would double the spacing every time
        // we rewrite the prompt, so join blocks with a single newline instead.
        const kids = [...editor.children];
        if (kids.length && kids.every((k) => BLOCK_TAGS.has(k.tagName))) {
          return kids.map((k) => k.innerText.replace(/\n$/, "")).join("\n");
        }
        return editor.innerText.replace(/\n$/, "");
      },
      conversationId() {
        const m = location.pathname.match(def.conversationPattern);
        return m ? m[1] : "new";
      },
    };
  }

  register(makeAdapter({
    name: "chatgpt",
    hosts: ["chatgpt.com", "chat.openai.com"],
    // Logged in: ProseMirror editor (#prompt-textarea). Logged out (seen
    // 2026-10-07): plain React <textarea name="prompt">, "Send message" button.
    editorSelectors: ["#prompt-textarea", 'div.ProseMirror[contenteditable="true"]',
      'textarea[name="prompt"]', 'textarea[aria-label="Chat with ChatGPT" i]', "#mobile-composer-prompt"],
    sendSelectors: ['button[data-testid="send-button"]', "#composer-submit-button", 'button[aria-label="Send message" i]'],
    conversationPattern: /\/c\/([\w-]+)/,
  }));

  register(makeAdapter({
    name: "claude",
    hosts: ["claude.ai"],
    editorSelectors: ['div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]'],
    sendSelectors: ['button[aria-label="Send message" i]', 'button[aria-label="Send Message"]'],
    conversationPattern: /\/chat\/([\w-]+)/,
  }));

  function forLocation(loc) {
    const host = loc.hostname;
    return registry.find((a) => a.hosts.some((h) => host === h || host.endsWith("." + h))) || null;
  }

  const api = { register, makeAdapter, forLocation, registry };
  root.PG = root.PG || {};
  root.PG.adapters = api;
})(globalThis);
