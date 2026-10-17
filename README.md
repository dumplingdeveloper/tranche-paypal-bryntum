# Tranche — payment-aware delivery board (PayPal × Bryntum)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Status: **Phase A spike** (not yet a product). See [DESIGN.md](DESIGN.md) and [docs/BUILD_LOG.md](docs/BUILD_LOG.md).

Freelancers and small agencies bill client work in PayPal invoice "tranches". Tranche puts every tranche on a
Bryntum Gantt as a milestone that the next phase depends on, so a late, failed or refunded PayPal payment visibly
blocks — and, after a human confirms an agent's preview, re-plans — the work that depends on it.

## Run the spike (mock PayPal data, no keys)

Requires Node.js >= 22.18 (type stripping) and Google Chrome for screenshots.

```bash
npm install          # installs Bryntum *trial* packages from public npm (watermarked, evaluation licence)
npm test             # scheduler unit tests
npm run dev          # http://127.0.0.1:4317/  and  /?preview=INV-2&assumed=2026-11-10
npm run spike:agent  # Copilot SDK agent calls schedule_shift_preview (needs Copilot login or BYOK env)
```

Bryntum Gantt/Scheduler/Calendar are commercial software installed from the public npm trial packages; they are
**not** redistributed in this repository and are not covered by this repository's MIT licence.
