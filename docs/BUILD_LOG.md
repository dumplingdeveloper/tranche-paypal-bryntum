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
| — | none yet | — | — |

- **Third-party code copied:** none.
