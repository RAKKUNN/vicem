# Security Policy & Zero-Trust Verification (`SECURITY.md`)

## 1. Zero-Dependency & Zero-Network Guarantee

- **Zero External Dependencies (`C-10`):** `vicem.mjs` uses **only** Node.js built-in modules (`node:fs`, `node:path`, `node:os`, `node:crypto`, `node:child_process`, `node:readline`, `node:util`, `node:url`, `node:sqlite`). There is no `package.json` dependency tree and zero supply-chain risk from third-party npm packages.
- **Zero Network Calls (`C-11`):**
  - `vicem.mjs` never imports `node:http`, `node:https`, `node:net`, `node:tls`, or `node:dgram`, and never calls `fetch()`.
  - `index.html` enforces `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">`, making outbound network connections impossible at the browser engine level.

## 2. Credential Blindness (`C-06`)

Vicem enforces a hardcoded blacklist (`CREDENTIAL_BLACKLIST_PATTERNS`) and never opens or harvests:
- `.env`, `.env.*`
- `auth.json`, `credentials.json`, `.credentials.json`
- `id_rsa`, `id_ed25519`, `*.pem`, `*.key`, `*.p12`, `*.pfx`
- `.npmrc`, `.pypirc`, `.netrc`, `kubeconfig`

## 3. 3-Tier Secret Redaction & No-Unredaction Policy (`UC-15`)

All harvested text, git diffs, logs, `.vicem/BATON.md`, and `.vicem/ledger.json` entries pass through `SecretRedactor.redact()`:
1. **Provider Regex Rules:** AWS (`AKIA`/`ASIA`), GitHub (`ghp_`/`github_pat_`), Anthropic (`sk-ant-`), OpenAI (`sk-`/`sk-proj-`), Google (`AIza`), Slack (`xox*`), Stripe (`sk_live_`), JWT, and PEM Private Keys.
2. **Shannon Entropy Detector:** High-entropy (`H >= 4.2` bits/char) secret assignments are masked while whitelisting UUIDs, Git SHAs, file paths, and CSS classes.
3. **No-Unredaction Rule:** Even when an agent calls `vicem_rehydrate(file_path, symbol_name)` via MCP, secrets remain redacted as `‹REDACTED:PROVIDER:HASH4›`.

## 4. Node.js Permission Model Sandbox

You can restrict `vicem.mjs` at the OS/V8 level using Node.js `--permission`:

```bash
node --permission \
  --allow-fs-read=/path/to/repo \
  --allow-fs-write=/path/to/repo/.vicem \
  --allow-child-process \
  vicem.mjs diet
```
