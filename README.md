# Tranche — payment-aware delivery board (PayPal × Bryntum)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Status: **M1–M3 built** (mock PayPal, Bryntum board, real-model agent). **M4-prep built**: a PayPal sandbox
client (REST Invoicing v2) behind `TRANCHE_PAYPAL=sandbox`, tested against a local stub only. It has **not yet been
run against the real PayPal sandbox** (no sandbox credentials yet). See [DESIGN.md](DESIGN.md) and
[docs/BUILD_LOG.md](docs/BUILD_LOG.md).

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

### Use the real PayPal sandbox
> **Honest status:** the sandbox client is written and tested against a local stub of the Invoicing v2 API
> (`npm test`, `npm run test:e2e`), but it has **not yet been run against api-m.sandbox.paypal.com**. Mock mode
> (the default) needs none of this.

Steps for a judge with their own PayPal developer account:
1. Follow PayPal's own steps (https://developer.paypal.com/api/rest/, "Get client ID and client secret"):
   "Select Log in to Dashboard and log in or sign up. Select Apps & Credentials. New accounts come with a Default
   Application in the REST API apps section. To create a new project, select Create App. Copy the client ID and
   client secret for your app." Use the sandbox credentials (Tranche only calls the sandbox host).
2. Put them in the credentials file (or export the same two variables, which override the file):
   ```bash
   mkdir -p ~/.config/tillwise
   printf 'PAYPAL_CLIENT_ID=%s\nPAYPAL_CLIENT_SECRET=%s\n' '<client id>' '<secret>' > ~/.config/tillwise/paypal-sandbox.env
   chmod 600 ~/.config/tillwise/paypal-sandbox.env
   ```
   Tranche never prints, logs or commits these values; errors show `***` instead.
3. `npm run sandbox:smoke`: gets a token, lists and searches invoices (read-only), creates one draft
   `TRANCHE-SMOKE-…` and deletes it again. Prints `ok`/`FAIL` per step.
4. `npm run sandbox:seed`: creates the five demo invoices `TRANCHE-INV-1…5` in your sandbox (idempotent: reruns
   find them by number instead of duplicating), sends INV-2/INV-5 as share links (no PayPal e-mail), records the
   INV-1/INV-4 payments as external bank transfers, and prints a table of ids and statuses.
5. `TRANCHE_PAYPAL=sandbox npm start`: the header badge says **PayPal: SANDBOX**; the app polls
   `search-invoices` every 30 s (`TRANCHE_POLL_MS`). If the demo invoices are missing it exits and asks you to run
   the seed.

What to know:
- Without credentials, `sandbox:smoke`, `sandbox:seed` and `TRANCHE_PAYPAL=sandbox npm start` print
  `NO CREDENTIALS` and exit 2 **without any network request**.
- "9 days overdue" is computed from the invoice's due date and the demo clock (`TRANCHE_TODAY`, default
  2026-11-03); PayPal has no OVERDUE status. Whether PayPal accepts a past due date at create time is unverified,
  so the seed has a documented fallback ([docs/FACTS_PAYPAL_INVOICING.md](docs/FACTS_PAYPAL_INVOICING.md) §6).
- *Client pays via PayPal* is disabled in sandbox mode: a real PayPal payment needs a sandbox buyer paying the
  invoice link in a browser. *Record bank transfer* records the payment through the API instead.
- Only invoices whose number starts with `TRANCHE-` are read or changed. `TRANCHE_INVOICE_PREFIX=TR2-` seeds a
  fresh set if a rehearsal left INV-2 paid.
- The client only talks to `https://api-m.sandbox.paypal.com`; the live host is refused in code.

The PayPal Server SDK 2.5.0 has no Invoicing controller, so the client uses REST. An optional cross-check that a
paid invoice's transaction exists, written with the PayPal Server SDK (`src/paypal/sdkPaymentCheck.ts`), is
unit-tested against a stub, is not wired into the app, and has **never been run against the sandbox**.

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
npm test             # 57 unit tests (scheduler, mock PayPal, sandbox client vs a local stub, broker, tools, API, SDK contract)
npm run test:e2e     # 9 Playwright tests through the real UI (scripted agent; headless Chrome; 1 in sandbox mode vs the stub)
npm run sandbox:smoke  # real PayPal sandbox, needs your credentials (see above)
npm run sandbox:seed   # real PayPal sandbox, needs your credentials (see above)
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
