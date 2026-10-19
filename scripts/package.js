// Builds dist/ai-prompt-guard-<version>.zip from extension/ (for Chrome Web
// Store / private hosting) and prints the extension ID for deployment policies.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension/manifest.json"), "utf8"));
const out = path.join(root, "dist", `ai-prompt-guard-${manifest.version}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
execFileSync("zip", ["-qr", out, ".", "-x", "icons/icon.svg"], { cwd: path.join(root, "extension") });
const id = fs.readFileSync(path.join(root, "keys/extension-id.txt"), "utf8").trim();
console.log(`Built ${path.relative(root, out)}  (extension ID ${id})`);
