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
| — | none (M4-prep, 2026-10-25: the sandbox client, seed/smoke scripts and the stub server were written fresh; entry 1's `liveClient.ts` was **not** opened or copied, on the user's instruction) | — | — |
| — | none (M4-live, 2026-10-26: the probe, the public-credentials helper, the call ledger and the real-sandbox e2e were written fresh) | — | — |

- **Third-party code copied:** none. New dependencies: `@paypal/paypal-server-sdk@2.5.0` (MIT, `npm view` → `license = 'MIT'`), `playwright-core@1.56.1` (dev, Apache-2.0).

## 2026-10-25 — M3.1 + M5 prep
- **Preview cosmetics (commit `ebf6eac`).** Cause, from `node_modules/@bryntum/gantt/gantt.css`: `.b-baselines .b-gantt-task-wrap.b-has-baselines{height:calc(1px * (1 - var(--b-baseline-wrap-size)) * var(--b-event-size))}` with `--b-baseline-wrap-size: .6`, so bars shrank from 18 px to 7.19 px while a preview was shown (measured in Chrome before the fix). `web/app.css` now keeps bars at full height and draws ghosts as a dashed frame around the bar band; milestone ghosts are 16 px dashed diamonds carrying their own label (`INV-2 → 10 Nov`), and the moved milestone's own label is hidden during the preview so labels never overlap. Tranche diamonds are now coloured through `.b-gantt-task-content::before` (previously the status colour filled a square behind the diamond). `test/e2e/board.e2e.ts` asserts 18 px bars in plan and preview, the diamond size, the ghost labels and zero label overlaps (`artifacts/e2e/02-apply-undo.json` → `preview_geometry`).
- **Bryntum licence facts for judging:** docs/FACTS_BRYNTUM_LICENCE.md.
- **Video pipeline copied** from the author's `hackathon_amazon/video/scripts` (GPL-2.0-or-later, kept as such in `video/`, md5s in video/LICENSES.md). Not rendered.
- **Live runs:** none in this step (Mac on battery, 19% → 10%, `pmset -g batt` "Battery Power"). Live total stays 4 turns. The live screenshots `artifacts/screenshots/live/L*.png` therefore still show the pre-M3.1 ghost style.

## 2026-10-25 — M4-prep: PayPal sandbox client, ready except for credentials
User go-ahead 2026-10-25T20:26Z. No live model runs and **no PayPal network calls** in this step (there are no
credentials: `~/.config/tillwise/paypal-sandbox.env` is still absent).

- **Interface:** `InvoicingClient` (`src/paypal/invoicing.ts`) gained `calls`, `remindersOn()` and an optional
  `baseUrl`; `InvoicingError` gained `debugId`. The mock is unchanged in behaviour.
- **Client** `src/paypal/sandboxClient.ts` (commit `f396fc7`, written fresh): REST Invoicing v2 on
  `https://api-m.sandbox.paypal.com`; OAuth2 client_credentials with the token cached until `expires_in − 60 s`;
  create draft / get / list / search / send / remind / record payment / record refund / cancel / delete draft;
  status mapping with overdue derived from the due date; 429 retried (Retry-After or 500 ms × 2ⁿ), 5xx/network
  retried for reads only (no `PayPal-Request-Id` in the Invoicing spec, so POSTs are not blindly repeated);
  PayPal-Debug-Id in every error; secrets masked. Every shape is cited in docs/FACTS_PAYPAL_INVOICING.md
  "Sandbox client".
- **Mode switch** (commit `c2bc434`): `TRANCHE_PAYPAL=sandbox` (legacy `TRANCHE_PAYPAL_MODE` accepted). Missing
  credentials → `NO CREDENTIALS`, exit 2, no request. Missing demo invoices → asks for `npm run sandbox:seed`,
  exit 2. Watcher polls every 30 s (`TRANCHE_POLL_MS`). Badge `PayPal: SANDBOX` (blue), or
  `PayPal: SANDBOX API · local stub` when the base URL is the loopback stub. *Client pays via PayPal* is disabled in
  sandbox mode (`409 NEEDS_BROWSER_PAYER`); the other demo controls call the API and are audited as
  `sandbox.demo_control`.
- **Scripts:** `npm run sandbox:seed` (idempotent, `TRANCHE-` numbers, reference `tranche-demo/v1`, due-date
  fallback, drift report) and `npm run sandbox:smoke` (read-only plus one draft that is always deleted).
- **Tests** (commits `fc00e76`, `9ca9bf6`, `e210ce0`): `test/unit/sandboxClient.test.ts` (22 tests) against
  `test/unit/helpers/paypalStub.ts`, a local `node:http` stub shaped from the spec (stub-only behaviour is marked
  `STUB_`). `test/unit/helpers/netSpy.mjs` is preloaded into child processes to prove the no-credentials paths make
  no `fetch` and no TCP connect (with a positive control). `test/e2e/sandbox.e2e.ts` drives the real UI in sandbox
  mode against the stub and writes `artifacts/screenshots/e2e/08-sandbox-mode-local-stub.png` and
  `artifacts/e2e/08-sandbox-mode-local-stub.json`.
- **Bugs the tests found and fixed:** the Basic-auth base64 of `client_id:secret` was not masked (the secrets test
  failed with `leaked QWZha2…`); an old access token would no longer be masked after a refresh (now every token
  ever held is masked); an `InvoicingError` with status 0 (network) made `writeHead(0)` throw, so the API answered a bare 500 (now 502 with the PayPal error).
- **APIMatic:** no APIMatic skill was used in this step. The sandbox client is plain REST because the PayPal Server
  SDK 2.5.0 has no Invoicing controller (user-verified fact); the APIMatic-guided SDK module from M3
  (`src/paypal/sdkPaymentCheck.ts`) is unchanged and still not wired in.
- **Results:** `npm test` 57/57, `npm run test:e2e` 9/9, `npx tsc` clean. The re-rendered screenshots of the 8
  earlier e2e tests only differed by timestamps and were restored with `git checkout -- artifacts`.
- **Unverified until a real sandbox run:** see docs/FACTS_PAYPAL_INVOICING.md §8.
- **Clean clone (2026-10-25, commit `f5fbcbb`):** `git clone` into `/tmp/tranche-m4clone` → `npm install` ("added 65
  packages") → `npx tsc` clean → `npm test` 57/57. `npm run sandbox:seed`, `npm run sandbox:smoke` and
  `TRANCHE_PAYPAL=sandbox npm start` each printed `NO CREDENTIALS: …` and exited 2. `npm start` (mock) printed
  `PayPal: MOCK …` and `Agent:  Copilot · gpt-6-luna (copilot-login:yuxinshiu63)` (no model turn was sent);
  `/api/state` returned INV-1 PAID, INV-2 SENT, INV-3 DRAFT, INV-4 PAID, INV-5 SENT and 12 tasks. Server (PID
  33308) killed; clone removed.

## 2026-10-26 — M5 draft video render (mock PayPal, live agent)
- **Visual nit fixed first (commit `686d954`):** the line crossing "INV-2 €4,800" was Bryntum's *Today* time-range
  line (DOM probe: `.b-sch-time-range.b-sch-line` z-index 10 above `.b-sch-foreground-canvas` z-index 6), not a
  dependency line. It now paints at z-index 5 (behind bars and labels) and its badge drops 20 px below the first
  summary bar. e2e test 1 asserts `line_z < foreground_z` and that the badge overlaps no bar
  (`artifacts/e2e/01-plan.json` → `today_line: {line_z: 5, foreground_z: 6, badge_on_bars: []}`). `npm run test:e2e`
  9/9, `npm test` 57/57; all e2e screenshots re-written by the tests.
- **Render:** `video/out/tranche-draft-mock.mp4`, 164.133333 s, 1920×1080, md5 `602ff146f730d297a7fb887379157cca`,
  10,095,503 bytes. Commands, fast-forward segments, frames and mismatches: docs/VIDEO_RENDER.md.
- **Live run:** `gpt-6-luna` / `copilot-login:yuxinshiu63`, **2 live user turns** (owner question + auto-watch on
  `INVOICING.INVOICE.PAID`), 5 + 3 tool calls (listed in docs/VIDEO_RENDER.md). Build total **6 of 35**. The dry run
  used the scripted agent (no video, not counted).
- **Pipeline changes:** compose.js card text from the scene and a sample-frame clamp; tts.js no longer overwrites
  video/LICENSES.md (provenance updated there).
- **CPU courtesy:** `pgrep -f moneyDeskLive` was empty before the TTS, the recording and the compose run; AC power.

## 2026-10-26 — Polish pass and Devpost media (mock PayPal, live agent)
- **UNDONE status (commit `7a07d15`):** broker status `undone` via `markUndone` (only approved schedule cards;
  otherwise `NOT_UNDOABLE`/`NOT_FOUND`), audit `confirmation.undone`, undo route answers 409 `CANNOT_UNDO` when the
  card is not approved. Tests: broker unit test, api test (status `undone`, second undo → 409), e2e test 2 asserts
  broker status, resolution and audit entry (state, not DOM text). `npm test` 58/58, `npm run test:e2e` 9/9.
- **Captions:** new `video/scripts/captions.js` (MIT): no "Narrator:" label, "Owner:" kept; split per sentence,
  then at the most balanced clause boundary, word boundary only as last resort (max 84 chars).
- **Scene (`video/scenes/tranche.json`):** first 15 s now say who it is for, the problem and why it matters; the
  payment section waits for each state before the line about it; the undo line says "the card now says undone";
  5 `snapshot` steps (new in `record.js`) write real UI stills for the gallery; `maxSilenceMs` 1000.
- **Render:** `video/out/tranche-draft-mock.mp4`, 166.133333 s, 1920×1080, md5 `94327a94fa872c627dbe53d66607c494`,
  10,412,462 bytes. ASR (user's faster-whisper tool) ratio 0.962, only spelling variants. Details, frames and
  remaining mismatches: docs/VIDEO_RENDER.md.
- **Live run:** `gpt-6-luna` / `copilot-login:yuxinshiu63`, **2 live user turns** (owner question + auto-watch on
  `INVOICING.INVOICE.PAID`), 5 + 3 tool calls. Build total **8 of 35**. The dry run used the scripted agent (not
  counted). Compose was re-run once on the same recording after the caption splitter change (no model turn).
- **Devpost media:** `video/scripts/devpost-media.js` (MIT) → `artifacts/devpost/` (5 gallery images 1920×1280,
  1 thumbnail 1280×720, `media-report.json`), all from the recorder's real UI stills.
- **CPU courtesy:** the user's busy check ran before the dry run, the render, the compose re-run and the ASR check.
  One deadlock happened: my idle scripted server (cwd in this repo) blocked the other entry's `/tmp/tw-busy.sh`
  while its waiting shell blocked mine. I stopped my server and waiting script (by PID via the tool) and let the
  other entry go first.

## 2026-10-26 — M4-live: the real PayPal sandbox
- **Credentials:** PayPal's default *public* sandbox set, written by the user to `~/.config/tillwise/paypal-sandbox.env`
  (mode 600). Source: https://github.com/paypal/postman-collections, `Collections/PayPal_Public_APIs.json`, collection
  variables `client_id` / `client_secret`; the collection's note: "PayPal Public Collection comes with following
  default public set of credentials stored at the Collection level. You may choose to override these values via
  environment level variables. You may bring your own credentials from PayPal Developer Dashboard there." Token
  `app_id` APP-80W284485P519543T. **Shared app** → fake names, `@example.com` recipients, a unique prefix per set.
  Values never printed; a byte scan of all repo files for id, secret and Basic base64 found 0 hits before committing.
- **PayPal call budget (≤ 250):** every request is appended to `artifacts/sandbox/paypal-calls.jsonl` (method, path
  without query, status, duration, PayPal-Debug-Id; no headers or bodies). Before the video: **163 requests**:

  | Ledger lines | Requests | What |
  |---|---|---|
  | 1–13 | 13 | `npm run sandbox:probe` — the fact probe (prefix `TRP-9112L-`) |
  | 14–20 | 7 | `npm run sandbox:smoke` — 5/5 ok, draft deleted (`artifacts/sandbox/smoke-2026-10-26.txt`) |
  | 21–40 | 20 | `npm run sandbox:seed` — new set `TR-AM5A7-` (`seed-2026-10-26.txt`) |
  | 41–49 | 9 | seed rerun — all five `found`, nothing created (`seed-2026-10-26-rerun.txt`) |
  | 50–72 | 23 | **accidental** `npm run test:sandbox-live`: I piped it into `head -0` meaning to check nothing, but that still runs the test. It failed early on a field-name bug in the test (`invoice_id`); its cleanup deleted the draft and cancelled the unpaid invoice |
  | 73–99 | 27 | live e2e run 2 — failed at the release step: the real search result has no payment date (see below) |
  | 100–103 | 4 | two read-only searches recording the search-result shape (the first only got numbers because `searchRaw` dropped the items) |
  | 104–133 | 30 | live e2e run 3 — test passed, but a poll after cleanup hit the deleted draft ("Unknown invoice INV-3") → fixed |
  | 134–163 | 30 | live e2e run 4 — **clean pass** (1/1, exit 0) |

  Non-2xx responses: the two expected probe 422s, one expected 404 (smoke checks its deleted draft), and one real
  **503** on a GET that the client retried successfully.
- **Fixes driven by the real API** (all unit-tested against the stub, which now mimics each answer):
  - `search_data.invoice_number` is a prefix match → every search sends the set's prefix, so nothing outside the
    set is read in the shared app.
  - Search items carry `payments.paid_amount` but no `transactions` → paid/refunded invoices are read once with
    GET, cached by status and amount; the stub's search strips `transactions` too.
  - Duplicate numbers are rejected (`DUPLICATE_INVOICE_NUMBER`) → `sandbox:seed` generates a `TR-XXXXX-` prefix and
    saves it in `.tranche/sandbox-state.json`; `-- --fresh` starts a new set.
  - Future payment dates are accepted → "Record bank transfer" uses the demo date (refunds stay clamped).
  - A draft deleted in PayPal no longer crashes the plan: the watcher keeps the last copy and the app audits
    `paypal.invoice_missing` once; `close()` ignores late polls.
  - Polling against the real sandbox is never faster than 30 s (5 s only for the loopback stub).
- **UI:** badge `PayPal: REAL SANDBOX API`; the PayPal-events header shows the host, "PayPal public default
  credentials" (when `app_id` is APP-80W284485P519543T) and the prefix; a visible note under the demo controls says a
  PayPal-button payment needs a sandbox buyer in a browser, so the demo records the payment via the API.
  Milestone labels got an opaque background (the Today line ran through "INV-2 €4,800").
- **Opt-in real-sandbox e2e** `npm run test:sandbox-live` (`LIVE_PAYPAL=1`; not part of `test:e2e`;
  `LIVE_PAYPAL=stub` runs the same flow against the stub for debugging and writes nothing). Seeds its own set,
  drives overdue → preview → apply → undo (`undone`) → Record bank transfer → `INVOICING.INVOICE.PAID` →
  reminder `stale` → release → apply, asserting broker, Bryntum engine and audit state and PayPal's own GET
  (`MARKED_AS_PAID`, `EXTERNAL`, `BANK_TRANSFER`, 2026-11-03). Then it deletes the draft and cancels the unpaid
  invoices it created. Evidence `artifacts/sandbox/sandbox-live-flow.json`; screenshots
  `artifacts/screenshots/sandbox/S1…S6`. Scripted agent → evidence about PayPal + Bryntum, not about the model.
- **`npm run sandbox:use-public-creds`** (new, MIT, written fresh): fetches PayPal's collection from GitHub at run
  time, accepts only the collection-level pair labelled "default public set of credentials", writes the env file
  with mode 600, never prints values, refuses to overwrite other credentials without `--force` (keeps `.bak`).
  Real run: `--dry-run` ok; a write to a temp file produced exactly the user's values (compared in code, not
  printed); against the user's file it reported "already present, file unchanged" (mtime unchanged).
- **Left in the shared sandbox app:** the probe invoice `TRP-9112L-PAST` (paid, cannot be cancelled), the paid
  `TR-AM5A7-INV-1/2/4` of the video set (its INV-5 was cancelled and its INV-3 draft deleted after the video), and the
  paid INV-1/2/4 of each live e2e set (cannot be cancelled). The e2e runs deleted their drafts and cancelled their
  unpaid invoices; a final check of `TR-8KZ7A-` (run 2) found nothing open.
- Tests: `npm test` 64/64, `npm run test:e2e` 9/9, `npm run test:sandbox-live` 1/1 (real sandbox).
- **Sandbox video** (scene `video/scenes/tranche-sandbox.json`, commit `ef2581f`): dry run first against the local
  stub with the scripted agent (no sandbox calls). Then, on AC power and after the user's busy check, one take with
  `TRANCHE_PAYPAL=sandbox` on the reserved `TR-AM5A7-` set and the live model: **2 live turns** (t1 owner question,
  5 tool calls; t2 auto-watch on `INVOICING.INVOICE.PAID`, 3 tool calls), build total **10 of 35**.
  `video/out/tranche-draft-sandbox.mp4`: 173.8 s, 1920×1080, md5 `c17d021d775ceeaf1e4f16a45b11c9cc`,
  10,835,970 bytes; ASR ratio 0.960 (spelling variants only). 29 PayPal requests during the take (ledger 164–192),
  including one real `401 invalid_token` mid-session that the client recovered from by fetching a new token.
  Gallery and thumbnail regenerated from this take's stills (`MEDIA_PAYPAL=sandbox` footer). Details:
  docs/VIDEO_RENDER.md.
- **Cleanup after the video:** 6 requests (ledger 193–198): `TR-AM5A7-` INV-5 cancelled, INV-3 draft deleted;
  `TR-8KZ7A-` nothing open. The used set's local state file was renamed to
  `.tranche/sandbox-state.used-TR-AM5A7-.json` (gitignored), so the next `npm run sandbox:seed` creates a new set.
- **Second accidental real run (my mistake, 13:53Z):** after the final `npm test` / `npm run test:e2e` I ran
  `npm run test:sandbox-live` believing it would print the skip message. The npm script itself sets `LIVE_PAYPAL=1`,
  so it started a real run. I stopped it after 20 requests (ledger 199–218: token, search, seed of 5 invoices);
  stopping it also killed the test before its cleanup. I then cancelled its unpaid INV-2 (`INV2-CFCW-…`) and INV-5
  (`INV2-6DTE-…`) and deleted its draft INV-3 (`INV2-NVB8-…`) by id, 4 requests (ledger 219–222). Its paid INV-1/INV-4
  remain (cannot be cancelled). No evidence or screenshots were written by it (they are written later in the flow).
  Lesson: `npm run test:sandbox-live` *is* the opt-in; the skip message only appears with plain `node --test`.
- **PayPal requests in this step: 222 of 250** (`wc -l artifacts/sandbox/paypal-calls.jsonl`).

## 2026-10-26 (afternoon) — sorted chips, in-app reminder on the real sandbox, leftovers, final video
Budget for this step: at most 80 PayPal requests. **Used: 55** = 35 in the ledger (lines 223–257) + **20 not in the
ledger** (see the mistake below).

- **Chip order.** PayPal's `search-invoices` returns newest first (INV-5, 4, 2, 1 for every prefix in
  `artifacts/sandbox/leftovers-2026-10-26.txt`), so sandbox chips ran INV-5 … INV-1. `Board.setInvoices`
  (`src/server/board.ts`) now keeps a copy sorted with a numeric `Intl.Collator` (`byInvoiceNumber`), so every view
  (chips, `/api/state`, agent tools) sees INV-1 → INV-5; INV-10 sorts after INV-9. Test `test/unit/board.test.ts`
  (reverse input, INV-10 after INV-9, plan dates unchanged on a reordered poll).
- **Leftovers (12 requests, ledger 223–234).** Session script (not committed): it learned each earlier prefix by
  GETting paid invoice ids from the ledger, searched each prefix once, and acted only on ids that were in our ledger.
  Found one open invoice, `TR-9ZRGT-INV-2` (`INV2-W2R3-PGML-54V6-HFN8`, accidental run 1), UNPAID → **cancelled**.
  Output: `artifacts/sandbox/leftovers-2026-10-26.txt`.
- **New demo set `TR-QNEP1-` (20 requests, NOT in the ledger).** My mistake: I ran `npm run sandbox:seed` without
  `TRANCHE_PAYPAL_CALL_LOG`, so its requests were not appended to `paypal-calls.jsonl`. The count comes from the
  script's own output, "PayPal requests sent: 20" (`artifacts/sandbox/seed-2026-10-26-set2.txt`).
- **In-app reminder on the real sandbox (7 requests, ledger 235–241).** New opt-in test
  `test/sandbox-live/remind.sandbox.ts` (`npm run test:sandbox-remind`, gated by `LIVE_PAYPAL_REMIND`, skipped by
  `test:sandbox-live` and `test:e2e`; `LIVE_PAYPAL_REMIND=stub` dry-runs it against the local stub, done first, 0
  PayPal requests). One real run on `TR-QNEP1-INV-5` (not overdue; INV-2 kept untouched for the video), no polling:
  scripted agent filed `cf_0002` (send_reminder, payload sha256 `1edcf4bd…`) → the test clicked *Send PayPal reminder*
  → `POST /v2/invoicing/invoices/INV2-WQG6-U8YU-N8MX-LC9K/remind` **204**, PayPal-Debug-Id `f222734b2490c` → GET 200,
  still `UNPAID`. The scripted agent also filed a schedule card `cf_0001` for INV-5 (left pending, not applied).
  Evidence `artifacts/sandbox/sandbox-remind-flow.json`, screenshot `artifacts/screenshots/sandbox/S7-real-sandbox-reminder-sent.png`
  (md5 `b51e102a03dfe7ff3cccf6444eebc251`).
- **Poll note fix.** S7 showed "polled every 30 s" although that run had polling off (the UI fell back to 30 when
  `paypal_poll_s` was null). `web/main.ts` now says "read at start-up and after demo actions (no background polling)"
  in that case, for the real sandbox and the stub. S7 itself was not retaken (it would have sent a second reminder);
  the evidence JSON notes this. The stub e2e screenshot `08-sandbox-mode-local-stub.png` changed accordingly (and
  shows the sorted chips).
- **Final video (13 requests, ledger 242–254).** Conditions checked right before: `pmset -g batt` "Now drawing from
  'AC Power'"; no `scripts/record.js`/`compose.js`/ffmpeg process from the other entry. To keep the polling server
  short-lived I ran the pipeline in its three steps: TTS first (all 17 clips cache hits, no server), then the server
  (`TRANCHE_PAYPAL=sandbox`, live gpt-6-luna) only for `record.js`, stopped by PID right after, then `compose.js`.
  **2 live model turns** (t1: 5 tool calls; t2 woken by `INVOICING.INVOICE.PAID`: 3 tool calls); build total **12 of
  35**. Every `search-invoices` took 16.3–19.4 s again. Details in docs/VIDEO_RENDER.md.
- **Cleanup of `TR-QNEP1-` (3 requests, ledger 255–257):** INV-5 cancelled (204, `f563156dd086a`), INV-3 draft
  deleted (204, `f344307730d90`); output `artifacts/sandbox/cleanup-2026-10-26-set2.txt`. Local state renamed to
  `.tranche/sandbox-state.used-TR-QNEP1-.json` (gitignored), so the next seed creates a new set.
- **Left in the shared app (all ours, none open):**

  | Prefix | Origin | Left |
  |---|---|---|
  | `TRP-9112L-` | probe | PAST MARKED_AS_PAID |
  | `TR-E50AC-` | live e2e run 4 | INV-1/2/4 MARKED_AS_PAID, INV-5 CANCELLED |
  | `TR-AM5A7-` | video set 1 | INV-1/2/4 MARKED_AS_PAID, INV-5 CANCELLED |
  | `TR-8KZ7A-` | live e2e run 2 | INV-1/2/4 MARKED_AS_PAID, INV-5 CANCELLED |
  | `TR-9ZRGT-` | accidental run 1 | INV-1/4 MARKED_AS_PAID, INV-2/5 CANCELLED |
  | `TR-FZY5Y-` | live e2e run 3 | INV-1/2/4 MARKED_AS_PAID, INV-5 CANCELLED |
  | `TR-BHJ3J-` | accidental run 13:53Z | INV-1/4 MARKED_AS_PAID, INV-2/5 CANCELLED |
  | `TR-QNEP1-` | reminder + final video | INV-1/2/4 MARKED_AS_PAID, INV-5 CANCELLED (reminded once first) |

  Paid invoices cannot be cancelled (`422 CANNOT_CANCEL_PAID_INVOICE`, FACTS §9). Drafts were deleted.
- Tests: `npm test` 65/65, `npm run test:e2e` 9/9, `npm run test:sandbox-remind` 1/1 (real sandbox, once).

## 2026-10-26 14:4x — submission docs, fresh-clone check (no PayPal calls, no renders, no model turns)
- docs/DEVPOST.md "YouTube upload": title (87 characters), description with pitch lines, chapters from
  `video/out/compose-report.json` `timeline[].start` (YouTube chapter rule quoted from
  https://support.google.com/youtube/answer/9884579), Made for kids: No, Public, thumbnail path, upload file with md5.
- Planned public repo `https://github.com/yuxinshiu63/tranche-paypal-bryntum` (branch `master`), marked "(public after
  publishing)" in "Try it out". Not created or pushed by me.
- README "Demo video" and docs/VIDEO_RENDER.md name `video/out/tranche-final-sandbox.mp4` as the submission video;
  `tranche-draft-sandbox.mp4` and `tranche-draft-mock.mp4` are marked superseded.
- **Fresh clone of `master` at 1130ea9** into a `mktemp -d` directory under /tmp (`git clone --branch master <this repo>`):
  `npm ci` → "added 65 packages in 6s" (Bryntum trial packages come from the public npm registry via the lockfile);
  `npm test` → tests 65, pass 65, fail 0; `PORT=4318 TRANCHE_AGENT=scripted npm start` → "Tranche running at
  http://127.0.0.1:4318/", "PayPal: MOCK", `GET /` 200, `/node_modules/@bryntum/gantt/gantt.css` 200,
  `/web/main.ts` 200, `/api/state` invoices INV-1 … INV-5 (server stopped by PID); `npm run test:e2e` → tests 9,
  pass 9, fail 0 (real Chrome against the clone). Temp directory deleted afterwards.

## 2026-10-26 14:5x — Potential Impact: primary-source facts on late payment (docs only)
No code, video or README changes; no PayPal calls, no model turns. Fetched with `curl -sL` on 2026-10-26 (UTC) and
read from the fetched files themselves (search engines were used only to find the URLs).

| # | Publisher | Document | URL | Fetched | Exact sentence(s) |
|---|---|---|---|---|---|
| 1 | European Commission | "Questions and Answers: Late Payment Regulation", Strasbourg, 12 September 2023 (QANDA/23/4412), 4-page PDF, HTTP 200, 53,006 bytes, md5 `3a2a0df8ba3e26240fa026d467718dae`; text via `pdftotext -layout` | https://ec.europa.eu/commission/presscorner/api/files/document/print/en/qanda_23_4412/QANDA_23_4412_EN.pdf | 2026-10-26T14:52:03Z (file mtime) | Q1: "Late payments have a major impact on SMEs. One in four bankruptcies are due to invoices not being paid on time." Q2: "In the EU, on average, one out of two invoices in commercial transactions are paid late (or not at all)." |
| 2 | UK Department for Business and Trade (page "From: Department for Business and Trade, Blair McDougall MP and The Rt Hon Peter Kyle MP", "Published: 24 March 2026") | Press release "Time to Pay Up: Government unveils toughest crackdown on late payments in over 25 years", HTTP 200, 83,656 bytes, md5 `c126ce5dab60fac0d076b39f48deb517` | https://www.gov.uk/government/news/time-to-pay-up-government-unveils-toughest-crackdown-on-late-payments-in-over-25-years | 2026-10-26T14:53:50Z (file mtime) | "Some 38 businesses shut their doors every single day because they are not paid on time – the equivalent of 266 a week, and well over a thousand in any given month." "Every small business owner, including tradespeople, freelancers, family firms and the self-employed, have to waste time and money chasing unpaid invoices when they could be growing their business." |

Not used: figures that I only saw in search summaries or secondary articles (e.g. "£11 billion", "86 hours a year");
the gov.uk page does contain "costing the UK economy £11 billion every year", but two sources were enough.
The EC figures describe EU commercial transactions in general (SMEs), not freelancers specifically; the UK sentence
names freelancers explicitly.

## 2026-10-27 21:0x — repo published (no code changes, no PayPal calls, no model turns)
- Published with `node ../hackathon_paypal/submission/publish-github.mjs --token-from-gh --preset tranche`, using the
  GitHub account logged in with `gh` on the build machine (`dumplingdeveloper`, OAuth token with the `repo` scope).
  The first push failed with `RPC failed; HTTP 400` (git 2.21.1, about 47 MB of PNG frames); the script now pushes with
  `-c http.postBuffer=524288000 -c http.version=HTTP/1.1`, and the retry succeeded.
- Checked without authentication: https://github.com/dumplingdeveloper/tranche-paypal-bryntum returns HTTP 200; the
  API reports `visibility: public`, default branch `master`, license `MIT`; `git ls-remote` HEAD = local `master`.
- Before pushing, every blob reachable from `master` was scanned for the PayPal sandbox client id/secret (and their
  Basic-auth base64), the gh token, and common token/key patterns: no real credential; the only pattern hits are the
  fake values in `test/unit/sandboxClient.test.ts`. All e-mail addresses are on `.example` domains.

## 2026-10-27 21:2x — YouTube upload (no code changes, no PayPal calls, no model turns)
- Uploaded `video/out/tranche-final-sandbox.mp4` from the user's Chrome (YouTube channel "Dumpling",
  `UCcbXF1fvPwJNOOFGlb5cu5A`, no other videos) with the title, description, "No, it's not made for kids" and
  **Public** from docs/DEVPOST.md "YouTube upload". Before selecting the file, its SHA-256 inside the page equalled the
  local file's (`af42b4f0…065ad9`). YouTube Studio: "Copyright check complete — No issues found".
- Checked without signing in: https://youtu.be/uTw7a5ZB9_M — oEmbed title = our title, author "Dumpling";
  watch page `playabilityStatus` OK, `isPrivate: false`, `isUnlisted: false`, `lengthSeconds: 173`, and the
  description is byte-identical to the one in docs/DEVPOST.md (1,132 characters, so the chapters are present).
- Not done: the custom thumbnail. Setting it from a script did not register in Studio, so the video shows YouTube's
  automatic frame (the full board). AI-use disclosure was left at "No": YouTube asks for it only for realistic content
  such as making "a real person appear to say or do something they didn't do"
  (https://support.google.com/youtube/answer/14328491); this is a screen recording with a synthetic narrator.
