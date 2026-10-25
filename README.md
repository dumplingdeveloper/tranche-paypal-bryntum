# Tranche — payment-aware delivery board (PayPal × Bryntum)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Status: **M1–M3 built** (mock PayPal, Bryntum board, real-model agent). Live PayPal sandbox (M4) is not
implemented yet. See [DESIGN.md](DESIGN.md) and [docs/BUILD_LOG.md](docs/BUILD_LOG.md).

Freelancers and small agencies bill client work in PayPal invoice "tranches". Tranche puts every tranche on a
Bryntum Gantt as a milestone that the next phase depends on, so a late, failed or refunded PayPal payment visibly
blocks the work that depends on it. An AI agent watches the invoices, previews how the plan should move (dates
computed by our scheduler, never by the model), drafts a PayPal reminder, and waits for the owner to click Apply.

## Run it (mock PayPal, no keys needed)

Requires Node.js >= 22.18 (TypeScript type stripping) and, for the tests, Google Chrome.

```bash
npm install     # also installs the Bryntum *trial* packages from public npm (watermarked)
npm start       # http://127.0.0.1:4317/  (next free port if 4317 is taken)
```

The agent is chosen automatically and shown in the top bar:

| You have | Agent |
|---|---|
| A GitHub Copilot login on this machine | `Agent: LIVE · Copilot · gpt-6-luna` (override with `TRANCHE_LLM_MODEL` or `COPILOT_MODEL`) |
| Your own key (BYOK, no GitHub login needed) | `TRANCHE_LLM_PROVIDER=openai TRANCHE_LLM_API_KEY=… TRANCHE_LLM_MODEL=gpt-4.1 npm start` (also `anthropic`, or `azure` with `TRANCHE_LLM_BASE_URL`) |
| Local Ollama | `TRANCHE_LLM_PROVIDER=ollama TRANCHE_LLM_MODEL=qwen3:4b-instruct npm start` (maps to the OpenAI-compatible endpoint `http://127.0.0.1:11434/v1`; the Phase A spike reached Ollama that way, ~140 s per turn on CPU; not re-run in M1–M3) |
| Nothing | `Agent: SCRIPTED (no LLM)`: a deterministic stand-in that calls the same tools; every reply is prefixed `[Scripted agent (no LLM)]` |

Other switches: `TRANCHE_AGENT=scripted` (force the scripted agent), `TRANCHE_AUTO_AGENT=0` (do not wake the agent on
PayPal events), `PORT=…`. `TRANCHE_PAYPAL_MODE` other than `mock` exits with "not implemented yet (M4)".

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

## Licences
This repository is MIT. Bryntum Gantt/Scheduler/Calendar are commercial software installed from the public npm trial packages
(`@bryntum/*-trial`); they are **not** redistributed here and are not covered by
this repository's licence. The trial watermark is intentionally left visible.

Evidence: [docs/FACTS_BRYNTUM.md](docs/FACTS_BRYNTUM.md), [docs/FACTS_COPILOT_BYOK.md](docs/FACTS_COPILOT_BYOK.md),
[docs/FACTS_PAYPAL_INVOICING.md](docs/FACTS_PAYPAL_INVOICING.md).
