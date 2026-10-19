# AI Prompt Guard (v0.1, lab prototype)

A browser extension that watches prompts sent to AI chat sites. It:

- **redacts** sensitive data with placeholders (`[SA_ID_NUMBER_1]`) and still lets the prompt through
- **warns** the user when the admin wants a warning (Accept & send redacted / Cancel & edit)
- **blocks** what policy forbids (card numbers, API keys, bulk data dumps)
- **redirects** unapproved AI sites to the approved one
- **logs** every prompt, redacted, to a collector


## Layout

```
extension/            the browser extension (Manifest V3)
  manifest.json       stable ID via "key": nkfbgnhhnhdpimbkgkbeddiijbeoklgc
  policy.default.json bundled default policy
  managed_schema.json settings an admin can push via enterprise policy
  src/detectors.js    SA ID (Luhn + DOB + citizenship), cards, email, SA phone, secrets, keywords
  src/policy.js       policy evaluation + consistent placeholders
  src/adapters.js     per-site selectors (ChatGPT, Claude) + generic fallback
  src/content.js      intercepts send (Enter / button) and paste; rewrites the prompt
  src/ui.js           warning / block dialogs (closed shadow DOM)
  src/background.js   config, unapproved-site redirect rules, log queue + upload
collector/server.js   receives logs, re-scrubs PII, writes NDJSON (Elastic optional, not connected)
collector/evidence-store.js  encrypted evidence store + retention purge
scripts/evidence.js   investigator tool: keygen / list / view (audited) / verify-audit
elastic/              index template + detection rule queries (NOT applied anywhere yet)
dns/                  OpenWrt DNS backstop script (NOT applied; review first)
deploy/               example force-install policies (Linux Chromium, Windows Chrome/Edge)
test/unit.test.js     detector + policy tests
test/e2e/             real Chromium + extension + mock ChatGPT/Claude (real ProseMirror) + collector
keys/                 extension signing key (private key is gitignored, keep it safe)
```

## Try it in the lab

```bash
# 1. collector (writes collector/data/events.ndjson; no Elastic unless ES_URL is set)
PG_TOKEN=change-me npm run collector

# 2. load the extension: chrome://extensions → Developer mode → Load unpacked → extension/
# 3. open its Options page: set collector URL http://127.0.0.1:8787, token change-me, your name
# 4. use chatgpt.com or claude.ai and type e.g. "check client 8001015009087"
```

## Tests

```bash
npm test            # unit: detectors, policy, evidence, admin
npm run test:e2e    # end-to-end in headless Chromium (CHROME_PATH to override /usr/bin/chromium)
npm run security    # security check: run after every change (see below)
```

## Security check (`npm run security`)

Run it after every change; it exits non-zero on any failure.

1. Security tests: crafted-input slowdowns (ReDoS), collector hardening (forged fields, size/batch
   limits, rate limit, CORS, weak-password refusal), admin (strict CSP, login lockout), terminal
   escape neutralising, private keys git-ignored.
2. Secret scan of the source tree.
3. Dangerous-code scan (innerHTML, eval, new Function, document.write, string timers, TLS-off).
4. Dependency audit. The extension and collector ship **no third-party code**.
5. Extension permission review.

Known accepted risks / production to-dos: plain HTTP (put the collector behind HTTPS); a shared
collector token means a user who extracts it can send fake events (use per-device tokens / mTLS);
`<all_urls>` host permission (needed for admin-listed redirects); the evidence access log is
tamper-*evident*, not tamper-proof (anchor its hash externally).

## Admin dashboard

`http://127.0.0.1:8787/admin` (user `admin`, password from `PG_ADMIN_PASSWORD`; `npm run lab` uses `lab-admin`).
Served by the collector from its own files. It doesn't use Elastic.

- **Executive view** (for a CEO): plain-English summary, "leaks prevented" headline, key numbers with
  trend vs the previous period, sensitive data stopped per day, a needs-attention list, AI tools used, and
  data categories. **No names or prompt text.**
- **Analyst view:** outcome breakdown, prompts per day, violations per day by outcome, per-site table,
  live activity monitor (redacted prompts, every 5 s), evidence-access audit with tamper check.
- Date range (today / 7 / 30 / 90 days); analyst view adds user and site filters. Every chart has a table view.

## Encrypted evidence (original values)

Off by default. When enabled, the extension encrypts the **original prompt and values** for any event with detections, using the org's **public** key, before anything is stored or uploaded. The collector stores ciphertext in `collector/data/evidence.ndjson` (separate from the normal log, never sent to Elastic) and deletes it after `PG_EVIDENCE_RETENTION_DAYS` (default 30).

```bash
npm run evidence -- keygen                      # once: makes keys/evidence-private.key (scrypt + AES-GCM, passphrase-protected)
#   -> paste the printed "evidence" block into the policy (policyJson)
npm run evidence -- list                        # metadata only
npm run evidence -- view <evidence-id> --analyst "jdoe" --reason "INC-1042 FICA leak review"
npm run evidence -- verify-audit                # check nobody edited/deleted access log entries
```

- Only the private key + passphrase can decrypt. Keep both in Bitwarden, **not** on the collector.
- Every `view` is written to a hash-chained access log (`collector/data/evidence-access.log`) **before** anything is shown; a reason is mandatory.
- A broken or missing key never falls back to plain text: the event is sent without evidence and flagged `evidence.error`.
- POPIA: staff policy must state that originals are retained (encrypted) for investigations; cover it in the client's PIIA.

## Policy actions

`allow` · `log_only` · `redact_silent` · `redact_warn` · `block`. The strictest action across all detections wins. See `extension/policy.default.json`. Admins push a full policy as the `policyJson` string setting. A broken policy falls back to the bundled default; it never silently disables protection.

## Known limits (v0.1)

- **Selectors not yet verified on the live ChatGPT/Claude sites.** They're tested against mock pages that use the same editor (ProseMirror) and the same selectors. If a live site differs, the generic fallback kicks in and an `adapter_degraded` event is logged.
- No network-layer hook yet (v0.2). If a site changes its UI so that the DOM layer can't find the prompt, enforcement depends on the generic fallback.
- File uploads, drag-and-drop text, images, desktop apps, mobile: not covered.
- No name/address detection yet (NER is v0.3).
- If the user has set "Ctrl+Enter to send" on a site, a plain Enter with sensitive data will still trigger the warning/send flow.
- Firefox and Safari builds: not yet (v0.2 / later).
- The enterprise-managed config path (`chrome.storage.managed`) is implemented but not tested end-to-end (that needs a system policy file).
