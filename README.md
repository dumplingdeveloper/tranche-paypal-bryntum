# Tranche — payment-aware delivery board (PayPal × Bryntum)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Status: **M1–M3 built** (mock PayPal, Bryntum board, real-model agent). **M4 built and run against the real PayPal
sandbox** (2026-10-26): REST Invoicing v2 behind `TRANCHE_PAYPAL=sandbox`, exercised with PayPal's default
*public* sandbox credentials (a shared app) — smoke, seed and a full real-UI flow (`npm run test:sandbox-live`).
Mock stays the default. See [DESIGN.md](DESIGN.md) and [docs/BUILD_LOG.md](docs/BUILD_LOG.md).

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
> **Status (2026-10-26):** run against `https://api-m.sandbox.paypal.com` with **PayPal's default public sandbox
> credentials** (option A below): `sandbox:smoke` 5/5, `sandbox:seed` (rerun is idempotent), and the full demo
> through the real UI (`npm run test:sandbox-live`, 1/1; screenshots in `artifacts/screenshots/sandbox/`). Not yet
> run with a judge's own sandbox app (option B), though it is the same code path. Mock mode (the default) needs
> none of this. Real PayPal answers and their evidence: [docs/FACTS_PAYPAL_INVOICING.md](docs/FACTS_PAYPAL_INVOICING.md) §9.

**Option A — PayPal's default public sandbox credentials (no PayPal account needed).** PayPal publishes a sandbox
credential set in its official Postman collection: https://github.com/paypal/postman-collections, file
`Collections/PayPal_Public_APIs.json`, collection variables `client_id` and `client_secret`. The collection's own
note says: "PayPal Public Collection comes with following default public set of credentials stored at the
Collection level. You may choose to override these values via environment level variables. You may bring your own
credentials from PayPal Developer Dashboard there." They are **not** copied into this repo. To use them:
```bash
npm run sandbox:use-public-creds   # fetches that file from GitHub, writes ~/.config/tillwise/paypal-sandbox.env (mode 600)
```
It never prints the values and refuses to overwrite a file holding other credentials unless you add `-- --force`
(a `.bak` copy is kept); `-- --dry-run` only checks. **It is a shared app**: anything you create with it is
visible to other users of those credentials. Tranche only creates fictional invoices (fake company names,
`@example.com` recipients) under its own random prefix.

**Option B — your own sandbox app.** Follow PayPal's steps (https://developer.paypal.com/api/rest/, "Get client ID
and client secret"): "Select Log in to Dashboard and log in or sign up. Select Apps & Credentials. New accounts come
with a Default Application in the REST API apps section. To create a new project, select Create App. Copy the client
ID and client secret for your app." Use the **sandbox** credentials, then:
```bash
mkdir -p ~/.config/tillwise
printf 'PAYPAL_CLIENT_ID=%s\nPAYPAL_CLIENT_SECRET=%s\n' '<client id>' '<secret>' > ~/.config/tillwise/paypal-sandbox.env
chmod 600 ~/.config/tillwise/paypal-sandbox.env
```
(Or export `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`, which override the file.) Tranche never prints, logs or
commits these values; errors show `***` instead.

**Then, with either option:**
1. `npm run sandbox:smoke` — token, list and search (read-only), then one draft `…SMOKE-…` that it deletes again.
   Prints `ok`/`FAIL` per step and the number of PayPal requests (7 in our run).
2. `npm run sandbox:seed` — creates the five demo invoices under a new prefix such as `TR-AM5A7-INV-1…5` and saves
   the prefix in `.tranche/sandbox-state.json`. INV-2/INV-5 are sent as share links (PayPal status `UNPAID`, no
   PayPal e-mail), INV-1/INV-4 get a recorded bank transfer (`MARKED_AS_PAID`), INV-3 stays `DRAFT`. Reruns find the
   saved set instead of duplicating it (20 requests first time, 9 on a rerun). `-- --fresh` starts a new set, e.g.
   after a rehearsal left INV-2 paid.
3. `TRANCHE_PAYPAL=sandbox npm start` — the badge says **PayPal: REAL SANDBOX API**; the PayPal-events header shows
   `api-m.sandbox.paypal.com`, the credentials ("PayPal public default credentials" for option A) and the prefix.
   The app polls `search-invoices` every 30 s (never faster against the real sandbox). If the demo invoices are
   missing it exits and asks you to run the seed.
4. In the app: review the overdue INV-2, apply and undo, then **Demo controls → Record bank transfer** for INV-2.
   That records a real external payment in PayPal (`MARKED_AS_PAID`); the next poll turns it into an
   `INVOICING.INVOICE.PAID` event, pending cards go stale, and the agent can release the plan to the payment date.

What to know:
- Without credentials, `sandbox:smoke`, `sandbox:seed` and `TRANCHE_PAYPAL=sandbox npm start` print
  `NO CREDENTIALS` and exit 2 **without any network request**.
- "9 days overdue" is computed from the invoice's due date and the demo clock (`TRANCHE_TODAY`, default
  2026-11-03); PayPal has no OVERDUE status. The real sandbox accepts the past due date and a payment dated on the
  demo clock.
- *Client pays via PayPal* is disabled in sandbox mode, with an on-screen note: a real PayPal payment needs a sandbox
  **buyer** paying the invoice link in a browser. The demo records the payment through the Invoicing API instead
  (*Record bank transfer*). We have not done a browser buyer payment.
- PayPal does not let anyone cancel a paid invoice (`CANNOT_CANCEL_PAID_INVOICE`), so paid demo invoices stay in the
  sandbox app; drafts and unpaid ones are deleted or cancelled by the live test.
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
4. Open **Demo controls** → *Client pays via PayPal* (mock) or *Record bank transfer* (mock or real sandbox; the
   payment is recorded in PayPal). Pending cards become **stale**; ask again and the agent proposes pulling the
   plan to the real payment date.

## Tests

```bash
npm test             # 64 unit tests (scheduler, mock PayPal, sandbox client vs a local stub, broker, tools, API, SDK contract)
npm run test:e2e     # 9 Playwright tests through the real UI (scripted agent; headless Chrome; 1 in sandbox mode vs the stub)
npm run sandbox:smoke  # real PayPal sandbox, needs credentials (see above)
npm run sandbox:seed   # real PayPal sandbox, needs credentials (see above)
npm run test:sandbox-live  # opt-in: full demo through the real UI against the REAL PayPal sandbox (~30 PayPal requests)
npm run test:byok    # BYOK wiring against a local stub endpoint with a fake key (no network)
npm run test:live    # real model through the real UI (needs a Copilot login; set EXPECTED_GITHUB_LOGIN=<you>)
```

Screenshots and evidence JSON are written by the tests to `artifacts/screenshots/{e2e,live,sandbox}` and
`artifacts/{e2e,live,sandbox}`.

## Licence
This repository's own code is MIT ([LICENSE](LICENSE)). Bryntum Gantt/Scheduler/Calendar are commercial software installed from the public npm trial packages
(`@bryntum/*-trial`); they are **not** redistributed here and are not covered by
this repository's licence. The trial watermark is intentionally left visible.

Third-party packages keep their own licences: `@github/copilot-sdk`, `@paypal/paypal-server-sdk` (MIT),
`playwright-core` (Apache-2.0, tests only). Provenance notes: [docs/BUILD_LOG.md](docs/BUILD_LOG.md).

Evidence: [docs/FACTS_BRYNTUM.md](docs/FACTS_BRYNTUM.md), [docs/FACTS_COPILOT_BYOK.md](docs/FACTS_COPILOT_BYOK.md),
[docs/FACTS_PAYPAL_INVOICING.md](docs/FACTS_PAYPAL_INVOICING.md).
