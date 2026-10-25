# Tranche — design (Phase A, 2026-10-17)

> Get paid before you build the next phase. A Bryntum Gantt where PayPal invoice "tranches" are real dependencies, and an AI agent that watches the money and proposes how to move the schedule, with a human confirming every change.

Evidence for every fact used here is in `docs/FACTS_BRYNTUM.md`, `docs/FACTS_COPILOT_BYOK.md`, `docs/FACTS_PAYPAL_INVOICING.md` and `docs/BUILD_LOG.md`.

## 1. Users and problem
- **Users:** freelancers and 2–10 person agencies (web, design, video, consulting) that bill fixed-price projects in milestones, e.g. 30% / 40% / 30%.
- **Problem:** the contract says "phase 3 starts after payment 2", but in practice the team keeps working. When a tranche is 9 days late, one of two things happens:
  - work continues unpaid, so cash-flow and credit risk build up;
  - or someone remembers late, and the client hears "we've paused" with no notice.
  
  Today nothing connects the invoice status to the plan. Rescheduling is manual, chasing payment is awkward, and the knock-on effect on other clients and on staff bookings is invisible.
- **Outcome we show:**
  - every payment tranche is visible as a milestone gating the next phase;
  - an overdue invoice visibly blocks its phase;
  - the agent calculates the exact slip (dates, launch impact, other clients unaffected) and drafts a polite chaser;
  - the owner approves it in one click;
  - when PayPal reports the invoice paid, the phase unblocks.

## 2. Concept choice (refined vs. the original brief)
Kept: "Tranche", the agency delivery board based on the Bryntum sponsor ideas #1 and #3 ("payment tranches marked as dependencies…", "agent watches PayPal payment events and automatically moves or flags milestones…").

Changes and why:

1. **Preview, then human-confirmed apply. Never auto-apply.** This still meets "an agent that drives the schedule itself" (sponsor page): the agent drives, the human steers.
2. **Ghost-bar preview using Bryntum `baselines`.** The proposal is computed by our code and checked against Bryntum's own engine (spike: 12/12 dates equal). It is not the LLM's own arithmetic.
3. **A team-capacity view (SchedulerPro/ResourceHistogram, from the Gantt bundle; FACTS_BRYNTUM §6).** It shows that moving Acme's build frees Dana for Birch's rollout, which targets the sponsor's "smartest resource booking" wording. The Calendar view (a client-facing "payment & milestone calendar") is a stretch goal.
4. **Rejected: a dispute triage board.** Entry 1 already does PayPal disputes, so it would weaken the "substantially different" requirement.

## 3. Demo storyboard (< 3 min, target 2:40)

| t | Screen | Voice-over (short) |
|---|---|---|
| 0:00–0:15 | Title, then the Gantt with 2 clients and coloured tranche milestones | "Freelancers bill in tranches. Tranche turns PayPal invoices into schedule dependencies." |
| 0:15–0:35 | Hover INV-2 (red, 9d overdue). "Build & integrations" is striped "blocked by INV-2". Capacity strip shows Dana booked. | "Acme's second payment is 9 days late, so the build phase is blocked." |
| 0:35–1:05 | Event feed: "INV-2 still SENT, due 25 Oct". The agent panel shows the model calling `schedule_shift_preview` (args visible). Ghost bars appear: 4 items move, launch +9d, Birch unaffected. | "The agent asks our scheduler, not its own guesswork, what moves." |
| 1:05–1:25 | The agent drafts a friendly reminder. Card: "Send PayPal reminder for INV-2?" (shows that PayPal uses its standard text, and our note is copied for email) | "It drafts a chaser. Nothing is sent without me." |
| 1:25–1:50 | The owner clicks **Apply schedule** and **Send reminder**. The Gantt animates the move; the capacity view re-books Dana; an undo button appears. The PayPal call is logged (mock or sandbox). | "One click applies it in the Bryntum engine, and it's undoable." |
| 1:50–2:15 | Payment arrives: sandbox "record payment", or a mock event `INVOICING.INVOICE.PAID`. The milestone turns green, and the agent proposes pulling the schedule back in (a preview, which is confirmed). | "When PayPal says paid, the board unblocks itself." |
| 2:15–2:35 | A quick refund case on Birch (INVOICING.INVOICE.REFUNDED leads to a flag on the Rollout phase), then the safety log | "Every action: preview, confirm, apply, audit." |
| 2:35–2:45 | End card: repo, `npm start`, BYOK | — |

## 4. Architecture

```
Browser (web/)                                 Node server (src/server, one process)
┌──────────────────────────────┐   SSE/JSON   ┌───────────────────────────────────────────────┐
│ Bryntum Gantt (+ capacity    │◄────────────►│ HTTP API: /api/board /api/events /api/confirm │
│  SchedulerPro/Histogram)     │              │                                               │
│ Agent panel + confirm cards  │              │ Agent (Copilot SDK session, BYOK-capable)     │
│ Preview = baselines/ghosts   │              │  tools: schedule_shift_preview (read-only)    │
│ Apply = setConstraint +      │              │         draft_reminder (read-only)            │
│   commitAsync, STM undo      │              │         request_apply / request_remind        │
└──────────────────────────────┘              │           → ConfirmationBroker (human gate)   │
                                              │ Domain: computeSchedule / previewShift        │
                                              │ InvoicingClient: Mock (default) | Live sandbox│
                                              │ PaymentWatcher: poll search-invoices → events │
                                              └───────────────────────────────────────────────┘
```

**New in this entry:**
- Bryntum UI.
- The tranche domain model and scheduler (`src/domain/*`, already spiked).
- The Invoicing client covering send, remind, cancel, record payment/refund and search.
- The payment watcher, which turns polling into normalised `INVOICING.INVOICE.*`-shaped events.
- The agent tools and the HTTP/SSE server.

**Reused from entry 1** (planned; as built in M1–M3 only the *patterns* were reused and no code was copied, see BUILD_LOG "Provenance"):
- the OAuth token cache + `paypalFetch` with `PayPal-Request-Id` + the sandbox-host guard (`hackathon_paypal/mcp-server/src/paypal/liveClient.ts`);
- `PayPalApiError` (`…/paypal/types.ts`);
- the `ConfirmationBroker` pattern (`hackathon_paypal/alexa-sim/src/permissionGate.ts:18`);
- the Copilot SDK `createSession` pattern (`hackathon_paypal/alexa-sim/src/copilotAgent.ts`).

**Not reused:** MCP server, WooCommerce, voice/Alexa, AG Studio.

## 5. Safety model
1. **The LLM never computes dates.** `schedule_shift_preview` returns dates computed by `src/domain/schedule.ts`, and the browser checks them against the Bryntum engine.
2. **Agent tools are read-only.** The tools that change something (`request_schedule_change`, `request_payment_reminder`) only create a pending confirmation, bound to the `preview_id` and a sha256 hash of the exact payload. Clicking Apply executes **that** preview. If the board changed in between (PayPal event, another apply, an undo), the card is swept to `stale` immediately and `approve()` re-checks the hash again, so a stale preview is never executed.
3. **Money-adjacent PayPal calls** (remind, cancel, record payment) always need a human click.
   - Live mode is limited to the sandbox (host guard on `api-m.sandbox.paypal.com`, as in entry 1).
   - Every write carries a `PayPal-Request-Id` for idempotency.
   - The rate limit is respected ("only 2 reminders in a day", INV:480).
4. **Undo:** applied schedule changes go through the Bryntum STM (`stm`, gantt.d.ts:164824), and an audit log records who, what, when and which preview.
5. **The SDK's built-in tools are disabled** (`availableTools` is restricted to our tools), and any other permission request is rejected (as in spike B).
6. **Secrets** live only in env or a gitignored env file, never in logs. BYOK keys are passed straight to the SDK `provider`.

## 6. Judge path (one command)
```
git clone … && cd tranche && npm install && npm start      # opens http://127.0.0.1:4317
```
- **Default: mock PayPal.** Deterministic invoices, with a "simulate payment event" button. This needs no PayPal account.
- **Agent:**
  - (a) If the judge has a Copilot login, it is used automatically.
  - (b) BYOK: `TRANCHE_LLM_PROVIDER=openai|anthropic|azure TRANCHE_LLM_API_KEY=… TRANCHE_LLM_MODEL=…`. No GitHub login or subscription is needed (proven: FACTS_COPILOT_BYOK Q4).
  - (c) Local Ollama works, but is slow (140 s per turn on CPU with a 4B model).
  - (d) With no LLM at all, a **scripted agent** replays the same tool calls deterministically, so the UI flow is always demonstrable. It is clearly labelled "scripted".
- **Optional: PayPal sandbox (M4, not built yet).** Planned: put `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` in `.env`; `npm run seed:sandbox` then creates and sends the 5 tranche invoices and the board runs live. Today `TRANCHE_PAYPAL_MODE` other than `mock` exits with "not implemented yet (M4)".
- **Bryntum:** `npm install` pulls the public trial packages from npm (no account needed; proven in FACTS_BRYNTUM §4). We never redistribute Bryntum code.

## 7. Differentiation vs entry 1 ("substantially different")

| Dimension | Entry 1: Tillwise × PayPal | Entry 2: Tranche |
|---|---|---|
| User | WooCommerce store owner | Freelancer / small agency |
| Job | Post-sale ops: refunds, disputes, tracking, invoices | Delivery planning gated by milestone payments |
| Primary UI | Voice/text chat (Alexa-style sim) + AG Studio dashboard | Bryntum Gantt + capacity view, agent side panel |
| PayPal surface | Orders/Captures refunds, Disputes, Tracking, Invoicing (one-off) | Invoicing lifecycle as **schedule dependencies** (send/remind/cancel/record payment/refund, search polling, INVOICING.* events) |
| Agent role | Executes store operations on request | Watches payment state and **re-plans time and people** |
| Integration | MCP server + WooCommerce | No MCP, no WooCommerce; direct SDK tools on the domain scheduler |
| Sponsor target | AG Studio sponsor prize + Agentic Commerce (`hackathon_paypal/DESIGN_PAYPAL.md:100,106`); no Bryntum use | **Bryntum** ("Best Use of Bryntum") + Best Use of PayPal + AI |
| Shared | GitHub Copilot SDK, preview→confirm gate philosophy, sandbox-only guard | same philosophy, different product |

## 8. Risks
| Risk | Evidence | Mitigation |
|---|---|---|
| Bryntum trial terms say "internal evaluation"; the trial is 45 vs 60 days; there is a watermark | FACTS_BRYNTUM §2 | The sponsor invites trial builds. The user asks Bryntum in Discord (2 min). We never commit Bryntum code. The watermark is acceptable and is what all trial entrants have. |
| The trial expires during judging (npm 7.3.7 published 2026-09-24; +45 d = 2026-11-08) | FACTS_BRYNTUM §3 (clock probe: no expiry seen up to 2027-03-01) | Judges install fresh (new per-install UUID). Record the video early. Re-probe before submission. |
| Time zone/DST shifts dates (Irish DST ends 2026-10-25) | Gotcha seen in spike A | **Resolved in M1:** every Bryntum date is anchored at local noon (`toBryntumDate`); the e2e time-zone matrix (Dublin, Los Angeles, Kolkata, Auckland) asserts engine dates = server dates before and after an apply. |
| No PayPal sandbox credentials yet | `~/.config/tillwise/paypal-sandbox.env` absent | Mock-first. The live client is optional. The user creates a sandbox app (about 10 min) only if wanted. |
| A custom reminder text is not honoured by PayPal | INV:6298, :6305 | Be honest in the UI: "PayPal sends its standard reminder; copy your note". |
| Webhooks need a public URL | WH:1699–1702; judges run locally | Polling `search-invoices` by default; the webhook receiver is optional. |
| Relicensing entry-1 code (GPL-2.0-or-later) as MIT | Entry 1 LICENSE | The user is the author, so this is their call. Record it in BUILD_LOG, or rewrite the small client from scratch. |
| LLM latency or a weak small model | Ollama run took 140 s | Default to Copilot/BYOK cloud models. The scripted agent is the fallback. Keep tools few and schemas tight. |
| Judges lack Chrome or Node ≥22.18 | package.json engines | README prerequisites. A hosted demo URL is a stretch goal. |

## 9. Milestone plan (estimates, not measurements)

| # | Milestone | Agent time | Tokens (incl. cached reads) | Live LLM turns |
|---|---|---|---|---|
| M1 | Server + API + MockInvoicingClient + PaymentWatcher + event feed; tests | 2–3 h | 1.5–2 M | 0 |
| M2 | Full Gantt UI: preview ghosts, apply/undo (STM), confirm cards, event feed panel, capacity view | 3–4 h | 2–3 M | 0 |
| M3 | Agent tools (preview, draft_reminder, request_apply/remind), ConfirmationBroker, scripted fallback, BYOK switch; end-to-end tests | 2–3 h | 1.5–2 M | ≤ 20 |
| M4 | LiveInvoicingClient (sandbox) + `seed:sandbox` (needs user creds; skipped if absent) | 1–2 h | 1 M | ≤ 5 |
| M5 | Recorded demo video (Playwright capture + captions), README, Devpost text, judge dry run on a clean clone | 3–4 h | 2–3 M | ≤ 10 |
| — | **Total** | **≈ 11–16 h agent time** (about 4–6 sessions) | **≈ 8–11 M** | **≤ 35** |

**User time (≈ 30–45 min total):**
- (1) optional: create a PayPal sandbox REST app and drop the 2 values in the env file (10 min);
- (2) optional: post a one-line question to Bryntum in the hackathon Discord (2 min);
- (3) create the public GitHub repo and push (5 min; the agent never pushes);
- (4) upload the YouTube video (5 min);
- (5) submit on Devpost and tick "Best Use of Bryntum" (15 min).

Target: feature-complete by 2026-11-05, submitted by 2026-11-10 (deadline is 12 Nov 2026 20:00 GMT).


### 9a. Actuals for M1–M3 (measured 2026-10-25)
- Wall clock: go-ahead message 2026-10-25T18:07:29Z → M1 commit 18:30:34Z → M2 commit 18:52:41Z → M3 commit 19:03:38Z → docs commit (see `git log`). About 1.1 h of wall-clock time, against the 7–10 h agent-time estimate above.
- Live LLM turns: **4** (2 runs × 2 turns, `gpt-6-luna`; run 1 lost to a clamshell sleep), against "≤ 20" for M3. Details in BUILD_LOG.
- Tokens: **not measured.** The session log has no per-call token counts for this run, so the 5–7 M estimate cannot be compared.
