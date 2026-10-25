# Tranche — payment-aware delivery board (PayPal × Bryntum)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Status: **M1–M3 built** (mock PayPal, Bryntum board, real-model agent). The live PayPal sandbox (M4) is **not
built yet**. See [DESIGN.md](DESIGN.md) and [docs/BUILD_LOG.md](docs/BUILD_LOG.md).

Freelancers and small agencies bill client work in PayPal invoice "tranches". Tranche puts every tranche on a
Bryntum Gantt as a milestone that the next phase depends on, so a late, failed or refunded PayPal payment visibly
blocks the work that depends on it. An AI agent watches the invoices, previews how the plan should move (dates
computed by our scheduler, never by the model), drafts a PayPal reminder, and waits for the owner to click Apply.

## Quick start for judges (about 2 minutes, no keys needed)

Requires Node.js >= 22.18 (runs TypeScript directly via type stripping). The tests also need Google Chrome.

```bash
git clone <this repo> tranche && cd tranche
npm install && npm start
# → Tranche running at http://127.0.0.1:4317/
```

Open the printed URL. What you get by default:
- **PayPal: MOCK** (yellow pill). Deterministic, sandbox-shaped PayPal Invoicing data (5 invoices, "demo today"
  3 Nov 2026). No PayPal account or key needed.
- **Agent**: picked automatically and shown in the top bar (table below). With nothing configured you get the
  clearly labelled scripted agent, so the whole flow still works offline.

### Agent modes
| You have | Start with | Top bar shows |
|---|---|---|
| A GitHub Copilot login on this machine | `npm start` | `Agent: LIVE · Copilot · gpt-6-luna` (change with `TRANCHE_LLM_MODEL` or `COPILOT_MODEL`) |
| Your own OpenAI / Anthropic / Azure OpenAI key (BYOK, no GitHub login) | `TRANCHE_LLM_PROVIDER=openai TRANCHE_LLM_API_KEY=… TRANCHE_LLM_MODEL=gpt-4.1 npm start` (`anthropic`; or `azure` plus `TRANCHE_LLM_BASE_URL` and optional `TRANCHE_AZURE_API_VERSION`) | `Agent: LIVE · BYOK openai · gpt-4.1` |
| Local Ollama | `TRANCHE_LLM_PROVIDER=ollama TRANCHE_LLM_MODEL=qwen3:4b-instruct npm start` (uses `http://127.0.0.1:11434/v1`) | `Agent: LIVE · BYOK openai · qwen3:4b-instruct` |
| Nothing | `npm start` (or force it with `TRANCHE_AGENT=scripted`) | `Agent: SCRIPTED (no LLM)`; every reply starts with `[Scripted agent (no LLM)]` |

How much of this is tested: the Copilot-login path has a passing live run through the real UI
(docs/BUILD_LOG.md, "Live runs"). BYOK is tested only against a local stub with a fake key (`npm run test:byok`).
The Ollama path is unit-tested for its config only in this build; the Phase A spike reached Ollama the same way
(~140 s per turn on CPU). The key is read from the `TRANCHE_LLM_API_KEY` environment variable; keep it out of the repo.

### Ports
`npm start` binds `127.0.0.1:4317`. If 4317 is busy it takes the next free port up to 4336 and prints it.
Set `PORT=…` to choose another start port. The tests start their own servers on free ports from 4317 upward.

### PayPal sandbox (not built yet)
Only the mock is implemented. `TRANCHE_PAYPAL_MODE=sandbox npm start` exits with "not implemented yet (milestone
M4: live PayPal sandbox)". The code is ready for it: everything talks to PayPal through the `InvoicingClient`
interface (`src/paypal/invoicing.ts`), and the mock implements it. The live client is planned as REST calls to
PayPal Invoicing v2 (the PayPal Server SDK 2.5.0 has no Invoicing controller), with credentials from
`PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` in a git-ignored `.env` (DESIGN.md §6). An optional
cross-check that a paid invoice's transaction exists, written with the PayPal Server SDK
(`src/paypal/sdkPaymentCheck.ts`), is unit-tested against a stub but has **never been run against the sandbox**.
See docs/FACTS_PAYPAL_INVOICING.md and DESIGN.md §6.

### Bryntum trial
`npm install` fetches Bryntum Gantt, Scheduler and Calendar as the public npm **trial** packages
(`@bryntum/gantt@npm:@bryntum/gantt-trial@7.3.7`, etc.), as the hackathon's Bryntum prize page suggests. The trial
shows a "Bryntum / Trial Version" watermark; we leave it visible on purpose. Bryntum's trial is commercial
software under the Bryntum EULA and is not part of this repository. What the trial licence says about judging, with
quotes: [docs/FACTS_BRYNTUM_LICENCE.md](docs/FACTS_BRYNTUM_LICENCE.md).

### Demo flow
1. INV-2 (Acme) is 9 days overdue, so "Build & integrations" is blocked (red hatched bar).
2. Click **Review overdue INV-2** (or type a question). The agent previews the shift: dashed ghost bars, a banner
   and an approval card. Nothing moves yet.
3. **Apply to plan** → the Bryntum engine moves the dependent chain in one STM transaction; **Undo** reverts it.
4. Open **Demo controls** → *Client pays via PayPal*. Pending cards become **stale**; ask again and the agent
   proposes pulling the plan to the real payment date.

## Tests

```bash
npm test             # 35 unit tests (scheduler, mock PayPal, broker, tools, API, SDK contract)
npm run test:e2e     # 8 Playwright tests through the real UI (scripted agent; headless Chrome)
npm run test:byok    # BYOK wiring against a local stub endpoint with a fake key (no network)
npm run test:live    # real model through the real UI (needs a Copilot login; set EXPECTED_GITHUB_LOGIN=<you>)
```

Screenshots and evidence JSON are written by the tests to `artifacts/screenshots/{e2e,live}` and
`artifacts/{e2e,live}`.

## Licence
This repository's own code is MIT ([LICENSE](LICENSE)). Bryntum Gantt/Scheduler/Calendar are commercial software installed from the public npm trial packages
(`@bryntum/*-trial`); they are **not** redistributed here and are not covered by
this repository's licence. The trial watermark is intentionally left visible.

Third-party packages keep their own licences: `@github/copilot-sdk`, `@paypal/paypal-server-sdk` (MIT),
`playwright-core` (Apache-2.0, tests only). Provenance notes: [docs/BUILD_LOG.md](docs/BUILD_LOG.md).

Evidence: [docs/FACTS_BRYNTUM.md](docs/FACTS_BRYNTUM.md), [docs/FACTS_COPILOT_BYOK.md](docs/FACTS_COPILOT_BYOK.md),
[docs/FACTS_PAYPAL_INVOICING.md](docs/FACTS_PAYPAL_INVOICING.md).
