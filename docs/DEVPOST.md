# Devpost submission draft: Tranche

Draft for https://paypalaihackathon.devpost.com. Text in [brackets] still has to be filled in by the user at
submission time (repo URL, video URL). Every claim below points at a file, a test or a commit in this repo.

## Checklist against the official rules (docs quoted in hackathon_paypal/submission/RULES_EXCERPTS.md)
| Rule (quoted) | How Tranche meets it | Status |
|---|---|---|
| "integrates the PayPal developer platform (using the free sandbox environment) along with an AI tool" | PayPal Invoicing tranches drive the schedule; AI agent on the GitHub Copilot SDK | PayPal runs on a **sandbox-shaped mock** today; live sandbox (M4) **not built** → must be built or clearly disclosed before submitting |
| "PayPal integration is central to the project" | Invoice status is the only thing that blocks or releases phases (`src/paypal/watcher.ts`, `src/domain/schedule.ts`) | ok |
| "Include a text description that should explain the features and functionality" | sections below | draft |
| "judges must be able to actually run or interact with a working build" … "clear, complete setup and run instructions" | README "Quick start for judges": `npm install && npm start`, no keys; verified on a fresh `git clone` (docs/BUILD_LOG.md "Clean clone") | ok |
| "public and open source by including an open source license file … visible at the top of the repository page" | `LICENSE` (MIT) | repo not published yet (user pushes; we never push) |
| Video "less than three (3) minutes" … "publicly visible on YouTube" | docs/VIDEO_SCRIPT.md (2:45 plan) | not recorded yet (M5) |
| "must not include third party trademarks … unless the Entrant has permission" | Video uses only our UI; Bryntum trial watermark visible as shipped; no music | check at render time |
| "any test account credentials, API keys, or sandbox login details necessary" | None needed in mock mode; agent falls back to the labelled scripted agent; BYOK documented | ok |
| "Third Party Integrations … must be authorized to use them in accordance with any … licensing requirements" | Bryntum trial per the sponsor page; open question on judging use → docs/FACTS_BRYNTUM_LICENCE.md §4 | **open: ask Bryntum on Discord** |
| "New & Existing … significantly updated after the start of the Hackathon Submission Period" | New project; first commit 2026-10-17 (below) | ok |
| "each Submission must be unique and substantially different" | Comparison table below | ok |

## Project name
Tranche

## Tagline (≤ 200 chars)
A delivery board where PayPal invoice tranches drive a Bryntum Gantt: late, paid or refunded payments re-plan the
work, an AI agent proposes the change, and nothing moves until you click Apply.

## Inspiration
Freelancers and small agencies split client projects into payment tranches ("30% up front, 40% after design, 30%
on launch"). When a tranche is late, the next phase should wait, but the plan lives in one tool and the invoices
in another, so people keep building unpaid work or forget to chase. The Bryntum prize page suggests exactly this:
"Agency delivery board (Gantt): multi-client project timelines with payment tranches marked as dependencies, so a
late PayPal payment visibly blocks the next phase" and "Agent-driven rescheduler … an agent watches PayPal payment
events and automatically moves or flags milestones".

## What it does
- **PayPal tranches as Gantt dependencies.** Each PayPal invoice is a milestone on a Bryntum Gantt; the next phase
  depends on it (finish-to-start). Milestones are coloured by PayPal status (paid, sent, overdue, draft, refunded,
  cancelled), and a phase whose tranche is unpaid is drawn as blocked.
- **Payment watcher.** Polls PayPal Invoicing (mock today) and turns changes into `INVOICING.INVOICE.*`-style
  events: overdue, paid, refunded, cancelled.
- **AI agent that re-plans, but never computes dates.** The agent (GitHub Copilot SDK; Copilot login, BYOK or
  Ollama) reads the board and calls `schedule_shift_preview` / `schedule_release_preview`. Our scheduler computes
  the new dates; the Gantt shows them as dashed ghost bars with a banner ("Build & integrations +16d … Dana
  double-booked 16–23 Nov").
- **Human confirmation for everything.** The agent can only *request* a change or a PayPal reminder. Each request
  is an approval card bound to a preview id and a SHA-256 payload hash. If PayPal state changes first (e.g. the
  client pays), pending cards become **stale** and the API refuses them (409).
- **Apply and undo inside Bryntum.** Apply re-constrains the tranche milestone and the Bryntum engine moves the
  whole dependent chain in one STM transaction; Undo reverts it through Bryntum's state-tracking manager. After
  each change the browser reports the engine's dates back and the server checks them against its own scheduler.
- **Team capacity.** A Bryntum SchedulerPro view shares the Gantt's project, so people's bookings move with the
  plan and double bookings are outlined.
- **PayPal reminder.** The owner can approve a PayPal invoice reminder drafted by the agent (mock call today).
- **Audit log** of every request, approval, rejection, apply, undo and stale sweep.

## How we built it
- **Bryntum Gantt 7.3.7 + SchedulerPro (trial packages)**: `ProjectModel`, finish-to-start dependencies,
  `setConstraint('startnoearlierthan', …)` + `commitAsync()`, the STM for undo, the baselines feature for preview
  ghosts (restyled so real bars keep their full height), labels, tooltips, time ranges. API references with d.ts
  line numbers: docs/FACTS_BRYNTUM.md §5.
- **PayPal**: Invoicing v2 shapes and statuses from PayPal's OpenAPI specs (docs/FACTS_PAYPAL_INVOICING.md),
  behind an `InvoicingClient` interface with a deterministic mock. An optional transaction cross-check written with
  the **PayPal Server SDK 2.5.0** (APIMatic-generated) lives in `src/paypal/sdkPaymentCheck.ts`.
- **APIMatic**: while writing that SDK module we used the APIMatic Context Plugin skills for the PayPal Server SDK
  (client initialization, authentication, calling endpoints, error handling, configuration/resilience, testing);
  the exact skill files and line numbers are in docs/BUILD_LOG.md ("M3 — optional PayPal SDK piece (APIMatic)").
  Honest scope: the module is unit-tested against a stub HTTP adapter (5 tests) but is **not wired into the app and
  has never run against the sandbox**. The installer `npx context-plugins install …` failed on this Mac's git
  2.21.1, so the skills were read from the public plugin repo.
- **AI**: GitHub Copilot SDK 1.0.15 with 6 custom tools and `availableTools` restricted to them; BYOK provider
  config for OpenAI / Anthropic / Azure / Ollama (docs/FACTS_COPILOT_BYOK.md).
- **Server**: Node.js 22 + TypeScript (type stripping, no build step), plain `node:http`.
- **Tests**: 35 unit tests, 8 Playwright end-to-end tests through the real UI that assert Bryntum engine dates,
  broker state, audit entries and rendered geometry; a BYOK wiring test against a local stub; and a live test with
  a real model through the real UI (docs/BUILD_LOG.md "Live runs").

## Challenges we ran into
- Time zones and DST: Irish summer time ended during the build; Bryntum dates are anchored at local noon, and the
  e2e matrix (Dublin, Los Angeles, Kolkata, Auckland) checks engine dates against the server's.
- Keeping the agent honest: the model never does date arithmetic; previews are bound to a hash, and stale ones are
  refused after any PayPal event, apply or undo.
- Bryntum's baseline layout squeezes bars to 40% height; we restyled the ghosts so the plan stays readable.
- Two PayPal Server SDK 2.5.0 behaviours we had to work around (docs/BUILD_LOG.md).

## Accomplishments that we're proud of
- A real model (gpt-6-luna via Copilot) drove the full flow through the UI: it chose the tools and arguments, the
  owner applied, the client paid, and the agent proposed the release (evidence `artifacts/live/`).
- Every screenshot and evidence file in `artifacts/` is written by the tests themselves.

## What we learned
[user to edit] Payment state is a scheduling input, not just accounting; Bryntum's engine makes "move everything
that depends on this payment" a one-line constraint change.

## What's next
- Live PayPal sandbox client (M4): REST Invoicing v2 send / remind / record-payment / cancel, plus polling.
- Calendar view of client deadlines; webhook receiver for hosted deployments.

## Built with
bryntum-gantt, bryntum-schedulerpro, paypal-invoicing, paypal-server-sdk, apimatic, github-copilot-sdk, openai,
anthropic, ollama, typescript, node.js, playwright

## Try it out
- Repo: [https://github.com/yuxinshiu63/<repo>] (MIT)
- Video: [YouTube URL]
- Run: `npm install && npm start` → http://127.0.0.1:4317/ (mock PayPal, no keys)

## Testing instructions for judges
See README "Quick start for judges". No credentials are needed: PayPal is mocked by default, and without a Copilot
login or BYOK key the clearly labelled scripted agent runs the same flow. To use your own model:
`TRANCHE_LLM_PROVIDER=openai TRANCHE_LLM_API_KEY=… TRANCHE_LLM_MODEL=gpt-4.1 npm start`.

## New vs existing (honest account)
Tranche is a **new project** started for this hackathon. All commits are in this repo (`git log`):

| Commit | Date (author time) | What |
|---|---|---|
| 24d8e1e | 2026-10-17 20:36 +01:00 | Spike A: Bryntum Gantt driven by mock PayPal invoice tranches |
| 0d94919 | 2026-10-17 20:44 +01:00 | Spike B: Copilot SDK agent calls `schedule_shift_preview` |
| c2b6170 | 2026-10-17 20:51 +01:00 | Phase A docs: facts, design, build log |
| c7072ac | 2026-10-25 18:30 +00:00 | M1: mock PayPal Invoicing, watcher, confirmation broker, audit, agent tools, server |
| e429822 | 2026-10-25 18:52 +00:00 | M2: Bryntum Gantt + SchedulerPro board, STM apply/undo, stale sweep, e2e suite |
| 5732400 | 2026-10-25 19:03 +00:00 | M3: live Copilot run through the real UI; optional PayPal SDK cross-check |
| a0c6718 | 2026-10-25 19:13 +00:00 | BYOK tests and docs |
| ebf6eac | 2026-10-25 20:17 +00:00 | M3.1: full-height bars and full-size milestone ghosts during preview |

**Reuse from our other entry.** The same author also submits "Tillwise × PayPal" (Money Desk), repo
`hackathon_paypal` (GPL-2.0-or-later, first commit 2026-10-16). **No code was copied from it** (docs/BUILD_LOG.md
"Provenance": "M1–M3 copied no entry-1 code; the broker, audit log, mock client and Copilot runner were written
fresh"). Shared ideas only: the GitHub Copilot SDK and a preview → confirm → apply safety philosophy.

## Why this is substantially different from our other entry
| | Tillwise × PayPal (Money Desk) | Tranche |
|---|---|---|
| User | WooCommerce store owner | Freelancer / small agency |
| Job | Post-sale operations: refunds, disputes, tracking, invoices | Delivery planning gated by milestone payments |
| Main UI | Voice/text assistant + AG Studio dashboards | Bryntum Gantt + SchedulerPro capacity view + approval panel |
| PayPal surface | Orders/captures refunds, Disputes, Tracking, one-off invoices | Invoicing lifecycle as schedule dependencies (status, remind, payment, refund) |
| Agent role | Executes store operations on request | Watches payment state and re-plans time and people |
| Stack | MCP server + WooCommerce | No MCP, no WooCommerce; tools over our own scheduler and the Bryntum engine |
| Sponsor prize | AG Grid / AG Studio | Bryntum (plus APIMatic only for the SDK module above) |

## Sponsor fit: Best Use of Bryntum
- Implements the prize page's first idea literally ("payment tranches marked as dependencies, so a late PayPal
  payment visibly blocks the next phase") and the agent-driven rescheduler idea for Gantt + Scheduler.
- Bryntum does the scheduling work: the engine propagates the finish-to-start chain after one constraint change;
  the STM gives undo; SchedulerPro shares the project for capacity; baselines show the preview.
- Verified in tests, not just screenshots: engine dates after `commitAsync()` equal the server scheduler in four
  time zones; header labels, task names and capacity labels are checked for clipping at 1920×940; the trial
  watermark is asserted present on both views.

## Known limitations (also in README)
- PayPal is a sandbox-shaped mock; no live sandbox calls yet (M4).
- Bryntum runs as the public trial with its watermark; licence questions for judging are open
  (docs/FACTS_BRYNTUM_LICENCE.md).
- BYOK verified only against a local stub; Ollama config unit-tested only in this build.
