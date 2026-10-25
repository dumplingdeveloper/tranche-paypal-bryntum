# Build log — Tranche (entry 2, PayPal AI Hackathon)

Machine: macOS, Node v26.0.0. Repo-local git identity: `yuxinshiu63 <217376842+yuxinshiu63@users.noreply.github.com>` (set with `git config user.name/user.email` inside this repo only; `~/.gitconfig` untouched). Never pushed.

## 2026-10-17 — Phase A

### Setup
- Checked ports with `lsof -nP -iTCP -sTCP:LISTEN`. 3337, 4178, 4179, 5000, 7000, 8088, 8097, 8098 and 11434 (Ollama) were already in use by other stacks. **This repo uses 4317** (dev server and screenshots) and **4318** (trial-clock probe), both bound to 127.0.0.1 and shut down by the scripts themselves.
- `git init`, then set the repo-local identity.
- `npm install --no-audit --no-fund @bryntum/gantt@npm:@bryntum/gantt-trial@7.3.7 @bryntum/scheduler@npm:@bryntum/scheduler-trial@7.3.7 @bryntum/calendar@npm:@bryntum/calendar-trial@7.3.7` gave `added 6 packages`, EXIT=0.
- `npm install @github/copilot-sdk@1.0.15`, plus the dev dependencies `typescript@5.9.3` and `@types/node@26.0.0`.

### Spike A — Bryntum Gantt from mock PayPal invoices (commit `24d8e1e`)
- The domain code (`src/domain/*`) holds 5 deterministic invoices and 2 projects, `DEMO_TODAY=2026-11-03`. It does a forward-pass schedule, and `previewShift` validates its input.
- `npm test` → 5/5 pass. `npm run typecheck` → clean.
- `npm run screenshot` uses headless Chrome via `playwright-core` 1.56.1, borrowed **read-only** from `/Users/shiyx/Downloads/claude_folder/hackathon_amazon/video/node_modules/playwright-core` (overridable with `PLAYWRIGHT_CORE`), with `channel: 'chrome'`, viewport 1920×900 and timezone UTC.
  - It writes `artifacts/screenshots/gantt-plan.png`, `artifacts/screenshots/gantt-preview-INV-2.png` and `artifacts/logs/screenshot-report.json`.
  - Engine check: 12/12 dates match in both the plan and the preview. No external requests were made.
- Iterations: first the layout was cropped, so I tuned tickSize, the columns and the date format. Then the d.ts renderer typings were too narrow, so I added a cast helper. Then a favicon 404 appeared, so I added a `data:` favicon.

### Spike B — Copilot SDK live tool call (commit `0d94919`)
- `npm run spike:agent` used the already logged-in Copilot account (`copilot-login:yuxinshiu63`) and model `gpt-6-luna`.
  - 1 live user turn and 2 model requests, 10.7 s.
  - The model called `schedule_shift_preview` with `{"invoice_number":"INV-2","reason":"overdue 9 days"}`.
  - Log: `artifacts/logs/agent-run-copilot-2026-10-17T19-38-35-499Z.json`.
- BYOK with fake OpenAI and Anthropic keys gave a provider HTTP 401 for each (`artifacts/logs/byok-fake-key-probe.txt`).
- BYOK with local Ollama `qwen3:4b-instruct` (no key, no GitHub auth, isolated COPILOT_HOME):
  - the first attempt hit the 120 s timeout, so I added `TRANCHE_TIMEOUT_MS`;
  - the second attempt succeeded in 140.8 s with the same tool args (`artifacts/logs/agent-run-byok-2026-10-17T19-44-30-537Z.json`).

### Trial clock probe + docs (commit: see `git log`, "Phase A docs")
- `node scripts/trial-clock-probe.ts` (port 4318) faked the browser clock at 2026-10-17, 2026-11-09, 2026-11-30, 2026-12-31 and 2027-03-01.
  - The Gantt rendered at every date, and no expiry popup or text appeared (`artifacts/logs/trial-clock-probe.json`, `artifacts/screenshots/trial-probe-clock-2027-03-01.png`).
- Wrote `docs/FACTS_BRYNTUM.md`, `docs/FACTS_COPILOT_BYOK.md` (copy at `~/.copilot/session-state/a5f98933-0ac2-4012-8b8b-91ed009d4889/files/copilot-byok-facts.md`), `docs/FACTS_PAYPAL_INVOICING.md` and `DESIGN.md`.
- Raw fetched pages (Bryntum download/EULA/docs, GitHub byok.md, PayPal event names) are cached outside the repo in the session folder `files/research/` and are not committed.

## 2026-10-25 — M1–M3 build (user go-ahead 2026-10-25T18:07Z)

Commits: `c7072ac` (M1), `e429822` (M2), `5732400` (M3 live + SDK), then the docs commit (see `git log`).

### M1 — server, mock PayPal, safety gate (commit `c7072ac`)
- `src/paypal/invoicing.ts` keeps the `InvoicingClient` interface; `src/paypal/mockInvoicing.ts` is the only implementation. `TRANCHE_PAYPAL_MODE` other than `mock` exits with code 2 ("not implemented yet (milestone M4)", `src/server/main.ts`). **No live Invoicing client was written.**
- `src/paypal/watcher.ts` polls the client and emits `INVOICING.INVOICE.*`-shaped events; `src/server/broker.ts` (confirmations bound to `preview_id` + sha256 payload hash), `src/server/audit.ts` (JSONL audit), `src/agent/tools.ts` (6 tools: 4 read-only, 2 that only create pending confirmations), `src/agent/scripted.ts`, `src/agent/copilot.ts`, `src/server/app.ts` (HTTP + SSE; JSON-only, same-origin POSTs).
- **DST finding:** Irish DST ended 2026-10-25. Bryntum dates created at local midnight drifted by one day in some time zones; anchoring every date at `YYYY-MM-DDT12:00:00` (`toBryntumDate`, `src/domain/gantt.ts`) fixed it. Proven by the e2e time-zone matrix (Dublin, Los Angeles, Kolkata, Auckland).
- `playwright-core@1.56.1` is now a devDependency (Apache-2.0); the read-only borrow from `hackathon_amazon` is no longer used.

### M2 — Bryntum board (commit `e429822`)
- Gantt: `viewPreset` base `weekAndMonth`, `tickWidth: 62`, headers `MMMM YYYY` / `D MMM`; name column 340 px. This fixes the two Phase A screenshot issues (overlapping header labels, truncated task names). The e2e test `plan loads…` enforces it geometrically: every header label, column header, task name, date cell, tranche chip and capacity label must sit fully inside its own box with no overlaps at 1920×940 (`readability()` in `test/e2e/harness.ts`).
- SchedulerPro capacity view shares the Gantt's project (bookings move with the plan); double-booked people get a red outline. Capacity bookings show the first word of the phase (bookings can be ~45 px wide); full name and dates are in the tooltip.
- Pending previews render as dashed Bryntum baselines ("ghosts"). Apply = one STM transaction titled with the confirmation id → `setConstraint('startnoearlierthan', …)` → `project.commitAsync()`; Undo = `stm.undo()` only if the top transaction is that confirmation. After every load/apply/undo the browser posts the engine's own dates to `/api/schedule/engine-report`, which audits `engine.verified` or `engine.mismatch`.
- Added `ConfirmationBroker.sweepStale()`: after a PayPal event, an apply or an undo, every pending card whose fresh payload hash differs is marked `stale` at once (audit `confirmation.marked_stale`), so no Apply button is shown for an outdated preview; `approve()` still re-checks.
- The Bryntum trial watermark is left untouched; the e2e test asserts it is rendered on both the Gantt and the capacity view.

### M3 — optional PayPal SDK piece (APIMatic) (commit `5732400`)

#### APIMatic Context Plugin probe
- Install command attempted as requested: `npx context-plugins install https://github.com/paypaldev/server-sdk-context-plugin-preview`.
- Result (log: session folder `files/apimatic-context-plugin-probe-2/install.log:20-25`): "Installing into: VS Code", then `git clone … (branch main) failed (exit 129)`, `EXIT=1`. Cause: this Mac's `git version 2.21.1 (Apple Git-122.3)` does not support the clone flags the installer uses.
- Fallback: the public repo clone in the session folder `files/server-sdk-context-plugin-preview` (HEAD `6aa0571`; `plugin.json:10` `"license": "MIT"`). Not vendored into this repo.

#### Skills read and resulting implementation choices (`src/paypal/sdkPaymentCheck.ts`, `test/unit/sdkPaymentCheck.test.ts`)
- `typescript-client-initialization/SKILL.md:15-37` (one flat options object, no builder) and `:108-118` (controllers are instantiated by hand). Result: `new Client({ environment, clientCredentialsAuthCredentials, timeout, httpClientOptions })` and `new TransactionSearchController(client)`.
- `typescript-authentication/SKILL.md:70-83` (client-credentials fields are `oAuthClientId` / `oAuthClientSecret`) and `:91-95` (token cached on the client, no 401-triggered refresh). Result: credentials property `clientCredentialsAuthCredentials` (read from the SDK's `src/configuration.ts:29`).
- `typescript-calling-endpoints/SKILL.md:36-47` (positional vs one options object) and `:122` (`ApiResponse<T>.result`). Result: `searchTransactions({ startDate, endDate, transactionId, fields })`, reading `res.result.transactionDetails`.
- `typescript-error-handling/SKILL.md:8-10` (throws on any non-2xx), `:41-44` (`result` is undefined on a bare `ApiError`), `:50-57` (error payloads keep wire field names). Result: errors become `verified: false` results with `name`/`debug_id`/`error` read at their wire spelling.
- `typescript-configuration-resilience/SKILL.md:80-90` (read `DEFAULT_RETRY_CONFIG`; a `0` timeout means none). The SDK's `src/defaultConfiguration.ts:17` is `timeout: 0` and `:23` is `maxNumberOfRetries: 0`. Result: explicit `timeout: 15_000` and `maxNumberOfRetries: 0`.
- `typescript-testing/SKILL.md:8-11` (stub axios adapter through `unstable_httpClientOptions`), `:61-65` (capture every call), `:96-116` (answer the token request from the adapter), `:216-218` (query parameters are in `req.url`). Result: the 5 offline contract tests, which run the real SDK code (token exchange, request building, deserialization) against a stub.

#### Two SDK 2.5.0 behaviours found by those tests (not in the skills)
- `searchTransactions` maps errors with `req.defaultToError(SearchError, …)` (`src/controllers/transactionSearchController.ts:186`). That path throws without parsing the body (`@apimatic/core/es/http/requestBuilder.js:515-526`; only `throwOn` errors get `loadResult`, `:786-788`). So `SearchError.result` is `undefined`; the code reads the raw `body`.
- The package root exports `OAuthProviderError` from `./models/oAuthProviderError.js` (the enum, `src/index.ts:183`), not the error class, so `instanceof OAuthProviderError` is not possible from the root. Token errors are recognised by their OAuth payload instead.
- Both are asserted by the test "SDK 2.5.0 facts this module relies on".

#### Status, honestly
- The module is **not wired** into the app and has **never been run against the PayPal sandbox** (no credentials). Mock mode never constructs it. Invoicing stays REST (the SDK has no Invoicing controller).

### Live runs (real model through the real UI) — budget ≤ 35 live turns for the whole build

| Run | Command | Model / auth | Live user turns | Model requests | Result |
|---|---|---|---|---|---|
| 1 (2026-10-25T19:00:28Z) | `caffeinate -i perl -e 'alarm shift; exec @ARGV' 900 npm run test:live` | `gpt-6-luna` / `copilot-login:yuxinshiu63` | 2 | 8 (4 + 4) | **Failed** on the final `errors == []` check: `console.error: Failed to load resource: net::ERR_NETWORK_IO_SUSPENDED`. `pmset -g log`: `2026-10-25 19:01:04 +0000 Sleep Entering Sleep state due to 'Clamshell Sleep' … Using Batt (Charge:19%)`. All tool-call, engine, STM and audit assertions before it had passed. Screenshots kept in `artifacts/screenshots/live/run1-failed-clamshell-sleep/`; turns in `artifacts/live/live-runs.jsonl` (first 2 lines). |
| 2 (2026-10-25T19:02:15Z) | `caffeinate -is perl -e 'alarm shift; exec @ARGV' 900 npm run test:live` | `gpt-6-luna` / `copilot-login:yuxinshiu63` | 2 | 7 (4 + 3) | **Passed** (`✔ LIVE: …`, 27.4 s). Evidence `artifacts/live/live-2026-10-25T19-02-17-629Z.json`, screenshots `artifacts/screenshots/live/L1…L4`. |

- **Total live user turns in M1–M3: 4** (of the 35 budget). The scripted agent is never counted; the live test fails instead of falling back to it.
- Run 2 tool calls (from the evidence file): turn 1 `get_board_status {}`, `schedule_shift_preview {"invoice_number":"INV-2","reason":"overdue 9 days"}`, `get_reminder_facts {"invoice_number":"INV-2"}`, `request_schedule_change {"preview_id":"pv_shift_INV-2_2026-11-10", …}`, `request_payment_reminder {"invoice_number":"INV-2", …}`; turn 2 `schedule_release_preview {"invoice_number":"INV-2"}`, `request_schedule_change {"preview_id":"pv_release_INV-2_2026-11-03", …}`.
- BYOK wiring check without any real key: `npm run test:byok` points `TRANCHE_LLM_PROVIDER=openai` at a local stub that answers 401. The runtime sent `POST /v1/chat/completions` with the fake key and `model: gpt-4.1`, and offered exactly the 6 Tranche tools (`artifacts/e2e/byok-local-stub.json`). This proves the wiring and the tool allow-list, **not** a working model. 0 model turns.
- No-login fallback: starting the clean clone with `HOME=/tmp/tranche-emptyhome` printed `Agent:  Scripted agent (no LLM) — No Copilot login (Not authenticated); set TRANCHE_LLM_* for BYOK`, and the agent's reply began with `[Scripted agent (no LLM)]`.

### Clean clone (2026-10-25T19:04Z)
- `git clone` of this repo into `/tmp/tranche-clone` → `npm install` → `npm start` printed `Tranche running at http://127.0.0.1:4317/`, `PayPal: MOCK …`, `Agent:  Copilot · gpt-6-luna (copilot-login:yuxinshiu63)`.
- `GET /api/state` returned 5 invoices and 12 scheduled tasks. Headless Chrome on the clone: `{"report":{"checked":12,"matched":12,"mismatches":[]},"agent":"Agent: LIVE · Copilot · gpt-6-luna","tasks":14}`, no console errors.
- In the clone: `npm test` → 34/34 pass; `npx tsc` clean. Server stopped by PID; clone removed afterwards.
- Re-run on commit 9b2b855 (2026-10-25, after the docs/BYOK commit): `npm install` → "added 65 packages"; `npm start` printed the same three lines; `/api/state` returned INV-1 PAID, INV-2 SENT, INV-3 DRAFT, INV-4 PAID, INV-5 SENT and 12 tasks; headless Chrome gave the same 12/12 report with `errors []`; `npm test` → 35/35 pass. Server (PID 23163) killed; clone removed.

## Provenance and licensing
- This repo is MIT (`LICENSE`), © 2026 yuxinshiu63.
- **Bryntum:** not redistributed. Only the npm alias is referenced in `package.json`/`package-lock.json`, and `node_modules/` is gitignored. The Bryntum trial is under the Bryntum EULA (see `docs/FACTS_BRYNTUM.md`), not MIT.
- **Entry 1 (`/Users/shiyx/Downloads/claude_folder/hackathon_paypal`, read-only):**
  - Phase A copied **no code** from it.
  - The spike follows the same *pattern* as `alexa-sim/src/copilotAgent.ts` (CopilotClient + `createSession` options) but was written fresh.
  - Entry 1 is licensed **GPL-2.0-or-later** (its `LICENSE` and `package.json`). The user (yuxinshiu63) is the author of that code, so they may relicense their own code as MIT here.
  - Any later copy, for example from `mcp-server/src/paypal/liveClient.ts` (OAuth cache, `paypalFetch`, sandbox host guard) or `types.ts` (`PayPalApiError`), will be listed below with the source path and commit.

| Date | From (entry 1 path) | To | Change |
|---|---|---|---|
| — | none (M1–M3 copied no entry-1 code; the broker, audit log, mock client and Copilot runner were written fresh) | — | — |

- **Third-party code copied:** none. New dependencies: `@paypal/paypal-server-sdk@2.5.0` (MIT, `npm view` → `license = 'MIT'`), `playwright-core@1.56.1` (dev, Apache-2.0).
