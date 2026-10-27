# Devpost submission draft: Tranche

Draft for https://paypalaihackathon.devpost.com. Text in [brackets] still has to be filled in by the user at
submission time (repo URL, video URL). Every claim below points at a file, a test or a commit in this repo.

## Checklist against the official rules (docs quoted in hackathon_paypal/submission/RULES_EXCERPTS.md)
| Rule (quoted) | How Tranche meets it | Status |
|---|---|---|
| "integrates the PayPal developer platform (using the free sandbox environment) along with an AI tool" | PayPal Invoicing tranches drive the schedule; AI agent on the GitHub Copilot SDK | Mock PayPal by default (so judges need no account). `TRANCHE_PAYPAL=sandbox` uses REST Invoicing v2 on **api-m.sandbox.paypal.com**; run on 2026-10-26 with PayPal's default *public* sandbox credentials: smoke 5/5, seed (idempotent rerun), and the full demo through the real UI (`npm run test:sandbox-live` 1/1, screenshots `artifacts/screenshots/sandbox/`). Not yet run with a judge's own app (same code path) |
| "PayPal integration is central to the project" | Invoice status is the only thing that blocks or releases phases (`src/paypal/watcher.ts`, `src/domain/schedule.ts`) | ok |
| "Include a text description that should explain the features and functionality" | sections below | draft |
| "judges must be able to actually run or interact with a working build" … "clear, complete setup and run instructions" | README "Quick start for judges": `npm install && npm start`, no keys; verified on a fresh `git clone` (docs/BUILD_LOG.md "Clean clone") | ok |
| "public and open source by including an open source license file … visible at the top of the repository page" | `LICENSE` (MIT) | repo not published yet (user pushes; we never push) |
| Video "less than three (3) minutes" … "publicly visible on YouTube" | docs/VIDEO_RENDER.md (final take: real PayPal sandbox + live model, 2:52.8) | rendered locally; not uploaded to YouTube |
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
in another, so people keep building unpaid work or forget to chase.

**Why it matters.** The European Commission: "In the EU, on average, one out of two invoices in commercial
transactions are paid late (or not at all)" and "One in four bankruptcies are due to invoices not being paid on time"
([Questions and Answers: Late Payment Regulation, 12 Sep 2023](https://ec.europa.eu/commission/presscorner/api/files/document/print/en/qanda_23_4412/QANDA_23_4412_EN.pdf)).
The UK Department for Business and Trade: "Some 38 businesses shut their doors every single day because they are not
paid on time", and small business owners "including tradespeople, freelancers, family firms and the self-employed, have
to waste time and money chasing unpaid invoices" ([Time to Pay Up, 24 Mar 2026](https://www.gov.uk/government/news/time-to-pay-up-government-unveils-toughest-crackdown-on-late-payments-in-over-25-years)).

The Bryntum prize page suggests exactly this:
"Agency delivery board (Gantt): multi-client project timelines with payment tranches marked as dependencies, so a
late PayPal payment visibly blocks the next phase" and "Agent-driven rescheduler … an agent watches PayPal payment
events and automatically moves or flags milestones".

## What it does
- **PayPal tranches as Gantt dependencies.** Each PayPal invoice is a milestone on a Bryntum Gantt; the next phase
  depends on it (finish-to-start). Milestones are coloured by PayPal status (paid, sent, overdue, draft, refunded,
  cancelled), and a phase whose tranche is unpaid is drawn as blocked.
- **Payment watcher.** Polls PayPal Invoicing (the mock by default; the real sandbox's `search-invoices` every 30 s in sandbox mode) and turns changes into `INVOICING.INVOICE.*`-style
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
- **PayPal reminder.** The owner can approve a PayPal invoice reminder drafted by the agent (a mock call by default; `POST …/remind` in sandbox mode). In-app path verified once on the real sandbox: agent card → owner clicks *Send PayPal reminder* → PayPal answered **204** (PayPal-Debug-Id `f222734b2490c`) and the invoice stayed `UNPAID` (`npm run test:sandbox-remind`, `artifacts/sandbox/sandbox-remind-flow.json`, docs/FACTS_PAYPAL_INVOICING.md §9). The 204 has no body, so we cannot see whether PayPal e-mailed the fake `@example.com` recipient.
- **Real PayPal sandbox mode.** The badge says **PayPal: REAL SANDBOX API**; "Record bank transfer" records a real
  external payment in PayPal (`MARKED_AS_PAID`), and the next poll makes the plan react. A PayPal-button payment
  needs a sandbox buyer in a browser, which the app says on screen; we use record-payment instead.
- **Audit log** of every request, approval, rejection, apply, undo and stale sweep.

## How we built it
- **Bryntum Gantt 7.3.7 + SchedulerPro (trial packages)**: `ProjectModel`, finish-to-start dependencies,
  `setConstraint('startnoearlierthan', …)` + `commitAsync()`, the STM for undo, the baselines feature for preview
  ghosts (restyled so real bars keep their full height), labels, tooltips, time ranges. API references with d.ts
  line numbers: docs/FACTS_BRYNTUM.md §5.
- **PayPal**: Invoicing v2 shapes and statuses from PayPal's OpenAPI specs (docs/FACTS_PAYPAL_INVOICING.md),
  behind an `InvoicingClient` interface with a deterministic mock (default) and a sandbox client written fresh
  for Tranche (`src/paypal/sandboxClient.ts`: OAuth2 client_credentials with a cached token, create / send / remind
  / record payment / refund / cancel / get / list / search, retries on 429 and on 5xx for reads, PayPal-Debug-Id in
  errors, secrets masked). It is tested against a local stub of the API and, since 2026-10-26, **run against
  api-m.sandbox.paypal.com** with PayPal's default public sandbox credentials (published in PayPal's own Postman
  collection, github.com/paypal/postman-collections; `npm run sandbox:use-public-creds` fetches them without
  printing them). Real answers changed the code: search is a prefix match, a share-link send gives `UNPAID`, a
  recorded payment gives `MARKED_AS_PAID`, and search results carry no payment dates, so paid invoices are read
  once with GET (docs/FACTS_PAYPAL_INVOICING.md §9). An optional transaction cross-check written with
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
- **Tests**: 64 unit tests (sandbox client, seed, smoke and the credentials helper against a local stub, including a
  no-credentials/no-network check), 9 Playwright end-to-end tests through the real UI that assert Bryntum engine dates,
  broker state, audit entries and rendered geometry; an opt-in end-to-end test against the **real PayPal sandbox**
  (`npm run test:sandbox-live`); a BYOK wiring test against a local stub; and a live test with a real model through
  the real UI (docs/BUILD_LOG.md "Live runs").

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
- The whole demo also ran against the real PayPal sandbox through the UI: overdue → preview → apply → undo →
  payment recorded in PayPal → stale reminder → release, with PayPal's own GET confirming `MARKED_AS_PAID`
  (`artifacts/sandbox/sandbox-live-flow.json`).
- Every screenshot and evidence file in `artifacts/` is written by the tests themselves.

## What we learned
[user to edit] Payment state is a scheduling input, not just accounting; Bryntum's engine makes "move everything
that depends on this payment" a one-line constraint change.

## What's next
- Run once with our own sandbox app (option B in the README) and a sandbox buyer paying through the PayPal invoice
  page in a browser.
- Calendar view of client deadlines; webhook receiver for hosted deployments.

## Built with
bryntum-gantt, bryntum-schedulerpro, paypal-invoicing, paypal-server-sdk, apimatic, github-copilot-sdk, openai,
anthropic, ollama, typescript, node.js, playwright

## YouTube upload (ready to paste)
Upload **after** the repo is published; the description links to it.

| Field | Value |
|---|---|
| File | `video/out/tranche-final-sandbox.mp4` — md5 `3619b8d8022fc94d29b7b5046148592a`, 10,974,961 bytes, 172.766667 s (2:52.8), 1920×1080 H.264 30 fps, AAC 48 kHz (docs/VIDEO_RENDER.md, "FINAL take") |
| Title (87 characters) | `Tranche: late PayPal invoices reschedule your Bryntum Gantt (AI agent + human approval)` |
| Thumbnail | `artifacts/devpost/youtube-thumbnail-1280x720.png` (1280×720, md5 `a68cad92edcddde45c0d7da8739b5faa`) |
| Audience | Made for kids: **No** |
| Visibility | **Public** |

Description (the first two lines carry the pitch; no `<` or `>` characters):

```text
Freelancers and small agencies paid in instalments either keep working unpaid or miss their own deadlines when a client pays late.
Tranche turns every PayPal invoice into a milestone on a Bryntum Gantt: an AI agent proposes new dates and a PayPal reminder, and nothing changes until you approve.

Recorded on the real PayPal sandbox API (PayPal's public default sandbox credentials, no real money) with a live model through the GitHub Copilot SDK. Bryntum Gantt and SchedulerPro run as the public trial (watermark visible). Waits for PayPal are fast-forwarded where the on-screen badge says so.

Chapters
00:00 Who it's for and the problem
00:23 An overdue PayPal invoice blocks the next phase
00:36 The owner asks the AI agent
00:57 Dashed preview: the agent can only request changes
01:21 Apply in the Bryntum engine, then Undo
01:40 The client pays; the payment is recorded in the PayPal sandbox
01:59 The agent proposes the release; the old reminder turns stale
02:21 Audit log and what is running
02:42 Recap

Code (MIT): https://github.com/dumplingdeveloper/tranche-paypal-bryntum
Built for the PayPal AI Hackathon on Devpost.
```

Chapter times come from the final video's compose timeline (`video/out/compose-report.json` `timeline[].start`,
rounded down): 0:00 = start (narration begins 0:05 after the 4 s intro), 0:23.67 line 3 "On the demo clock…", 0:36.47
owner question, 0:57.24 "The dashed ghost bars…", 1:21.33 "Apply runs inside the Bryntum engine…", 1:40.05 "Now the
client pays…", 1:59.51 "It proposes moving the plan…", 2:21.93 "Every request, approval…", 2:42.89 "Tranche: PayPal
payments that move the plan…"; the video ends at 2:52.77, so the shortest chapter (2:42 → end) is 10.8 s. YouTube's
rule, quoted from https://support.google.com/youtube/answer/9884579 (fetched 2026-10-26): "Make sure that the first
timestamp you list starts with 00:00. Your video should have at least three timestamps listed in ascending order. The
minimum length for video chapters is 10 seconds." The chapter list therefore starts at `00:00`, has 9
entries in ascending order, and none is shorter than 10 s.

## Try it out
- Repo: https://github.com/dumplingdeveloper/tranche-paypal-bryntum (MIT; branch `master`; public since 2026-10-27)
- Video: [YouTube URL, after upload] — the file is `video/out/tranche-final-sandbox.mp4` (see "YouTube upload" above)
- Gallery (3:2, 1920×1280) and YouTube thumbnail (1280×720): `artifacts/devpost/` (real UI stills from the real-sandbox
  recorded live take; see docs/VIDEO_RENDER.md "Devpost media")
- Run: `npm install && npm start` → http://127.0.0.1:4317/ (mock PayPal, no keys)
- Real PayPal sandbox: `npm run sandbox:use-public-creds && npm run sandbox:seed && TRANCHE_PAYPAL=sandbox npm start`
  (PayPal's public default credentials, a shared app), or your own sandbox app (README "Use the real PayPal sandbox")

## Testing instructions for judges
See README "Quick start for judges". No credentials are needed: PayPal is mocked by default, and without a Copilot
login or BYOK key the clearly labelled scripted agent runs the same flow. For the real PayPal sandbox, the README gives
two options: PayPal's public default sandbox credentials (`npm run sandbox:use-public-creds`) or your own sandbox app. To use your own model:
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
| 42e5651 … 3edae49 | 2026-10-25 20:19–20:23 +00:00 | Docs: Bryntum licence facts, README, this draft, video script |
| f396fc7 | 2026-10-25 20:31 +00:00 | M4-prep: sandbox client for REST Invoicing v2 (written fresh) |
| c2bc434 | 2026-10-25 23:30 +00:00 | M4-prep: `TRANCHE_PAYPAL=sandbox` switch, SANDBOX badge, polling, seed and smoke scripts |
| fc00e76 | 2026-10-25 23:34 +00:00 | M4-prep: stub-server tests, no-credentials/no-network test |
| 9ca9bf6 | 2026-10-25 23:38 +00:00 | M4-prep: sandbox-mode e2e through the UI against the stub |
| e210ce0 | 2026-10-25 23:40 +00:00 | M4-prep: error `field` in messages; due-date fallback |
| ffd7aa8 … 686d954 | 2026-10-25 23:42–23:53 +00:00 | M4-prep docs; Today line drawn behind bars and labels |
| f19307b | 2026-10-26 00:22 +00:00 | M5: draft demo video render (mock PayPal, live gpt-6-luna agent) |
| 7a07d15 | 2026-10-26 00:38 +00:00 | Undo marks the schedule card UNDONE (broker state + audit) |
| d7fc3c3, 8a94832 | 2026-10-26 12:28 +00:00 | Video polish; Devpost gallery and thumbnail from real UI stills |
| afa1feb | 2026-10-26 13:13 +00:00 | M4-live: fixes from the real PayPal sandbox, opt-in real-sandbox e2e, REAL SANDBOX API badge |
| c1072d6 | 2026-10-26 13:15 +00:00 | `npm run sandbox:use-public-creds` |
| d544b95, ef2581f | 2026-10-26 13:20–13:25 +00:00 | M4-live docs; sandbox video scene |
| f1337ec, 9727250 | 2026-10-26 13:55 +00:00 | M4-live: sandbox video take, frames, Devpost media, cleanup |
| 53f58be | 2026-10-26 14:36 +00:00 | Sorted invoice chips; in-app PayPal reminder on the real sandbox (204); leftovers cleanup |
| 1130ea9 | 2026-10-26 14:39 +00:00 | Final sandbox video re-render with sorted chips; Devpost media; docs |
| the commit after 1130ea9 | 2026-10-26 | Docs: YouTube upload fields and chapters, planned repo URL, submission video named; fresh-clone check |

The official rules give the window: "Submission Period: Thursday Oct 1, 2026 (9:15 am Pacific Time) – Thursday
Nov 12, 2026 (12:00 pm Pacific Time)" (https://paypalaihackathon.devpost.com/rules, fetched by the user
2026-10-25). Tranche's first commit (2026-10-17) is inside it, so this is a new project.

**Reuse from our other entry.** The same author also submits "Tillwise × PayPal" (Money Desk), repo
`hackathon_paypal` (GPL-2.0-or-later, first commit 2026-10-16). **No code was copied from it** (docs/BUILD_LOG.md
"Provenance": "M1–M3 copied no entry-1 code; the broker, audit log, mock client and Copilot runner were written
fresh"; the M4-prep sandbox client was also written fresh, not adapted from entry 1's PayPal client). Shared ideas only: the GitHub Copilot SDK and a preview → confirm → apply safety philosophy.

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
- PayPal is a sandbox-shaped mock by default. Sandbox mode has run against the real sandbox only with PayPal's
  shared public default credentials, not with our own app; no browser buyer payment was made (we record payments
  through the API); a future-dated refund and `PARTIALLY_PAID` are unverified against the
  real sandbox, and the in-app remind path ran there once (204) (docs/FACTS_PAYPAL_INVOICING.md §8). Paid demo invoices cannot be cancelled, so they stay in the
  shared app.
- Bryntum runs as the public trial with its watermark; licence questions for judging are open
  (docs/FACTS_BRYNTUM_LICENCE.md).
- BYOK verified only against a local stub; Ollama config unit-tested only in this build.
