// Bundles the mock editor and prepares a test copy of the extension that also
// runs on http://localhost (the real build only matches chatgpt.com/claude.ai).
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "../..");
const tmp = path.join(__dirname, ".tmp", "ext");

esbuild.buildSync({
  entryPoints: [path.join(__dirname, "fixtures/editor.src.js")],
  bundle: true,
  outfile: path.join(__dirname, "fixtures/editor.bundle.js"),
  format: "iife",
  logLevel: "warning",
});

esbuild.buildSync({
  entryPoints: [path.join(__dirname, "fixtures/react-textarea.src.jsx")],
  bundle: true,
  outfile: path.join(__dirname, "fixtures/react-textarea.bundle.js"),
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});

fs.rmSync(tmp, { recursive: true, force: true });
fs.cpSync(path.join(root, "extension"), tmp, { recursive: true });
fs.copyFileSync(path.join(__dirname, "test-adapters.js"), path.join(tmp, "src/test-adapters.js"));

const manifest = JSON.parse(fs.readFileSync(path.join(tmp, "manifest.json"), "utf8"));
for (const entry of manifest.content_scripts) entry.matches.push("http://localhost/*");
const cs = manifest.content_scripts[0];
cs.js.splice(cs.js.indexOf("src/content.js"), 0, "src/test-adapters.js");
fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify(manifest, null, 2));

// Existing e2e tests check per-rule behaviour (silent vs warn per type), so the
// test copy of the default policy leaves the global warning switch unset.
// The switch itself has its own tests.
const polPath = path.join(tmp, "policy.default.json");
const pol = JSON.parse(fs.readFileSync(polPath, "utf8"));
delete pol.warning.enabled;
fs.writeFileSync(polPath, JSON.stringify(pol, null, 2));

// Open shadow root in the test build only, so tests can click dialog buttons.
const uiPath = path.join(tmp, "src/ui.js");
const ui = fs.readFileSync(uiPath, "utf8");
if (!ui.includes('mode: "closed"')) throw new Error("ui.js shadow mode not found");
fs.writeFileSync(uiPath, ui.replace('mode: "closed"', 'mode: "open"'));

console.log("fixtures built; test extension at", tmp);
