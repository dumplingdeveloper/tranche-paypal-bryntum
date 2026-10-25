# Tranche demo video: script and render plan (target 2:45, hard limit < 3:00)

Status: **script only, not rendered.** Rendering is M5, after review.

The narration is written for the Kokoro TTS voices the pipeline already uses (NARRATOR `af_bella`, OWNER
`am_fenrir`, see video/LICENSES.md). The screen is the real app at 1920×940 (the pipeline records
`1920 × (1080 − 140)` and adds a 140 px caption band, so the frame matches our e2e test viewport exactly).

## Scenes
| # | Time | Screen (what the recorder does) | Narration (voice) |
|---|---|---|---|
| 1 | 0:00–0:12 | Title card: "Tranche: PayPal tranches drive the delivery plan". Then the board loads (`goto /`). | NARRATOR: "Freelancers and small agencies get paid in tranches. Tranche turns each PayPal invoice into a dependency on a Bryntum Gantt." |
| 2 | 0:12–0:32 | Board at rest. Hover INV-2 card (red, 9 days overdue), then the red hatched "Build & integrations" bar and the blocked chip. | NARRATOR: "Acme's second payment, INV-2, is nine days overdue, so the build phase it unlocks is blocked. The capacity view below shares the same Bryntum project, so people's bookings follow the plan." |
| 3 | 0:32–1:02 | Type in the agent box "Invoice INV-2 for Acme is 9 days overdue. What should happen to the plan?" → Send. Tool chips appear (`get_board_status`, `schedule_shift_preview` with its arguments). Ghost bars and the PREVIEW banner appear. | OWNER reads the question. NARRATOR: "The agent never does date maths. It calls our scheduler, which returns the exact phases that move. The dashed ghosts are a preview; nothing has changed yet." |
| 4 | 1:02–1:22 | Zoom on the approval cards: schedule change and PayPal reminder, each with its payload hash. | NARRATOR: "It asks for two things: apply the new dates, and send a PayPal reminder with a friendly note. Each request is bound to a preview and a hash. Only I can approve." |
| 5 | 1:22–1:45 | Click **Apply to plan**. Gantt moves the chain; Dana's bookings outlined as double-booked; audit shows "Bryntum engine ✓ 12/12". Click **Undo**, then Apply again (or skip undo if over time). | NARRATOR: "Apply runs inside the Bryntum engine as one undoable transaction. The browser reports the engine's dates back and the server checks every one." |
| 6 | 1:45–2:15 | Open Demo controls → **Client pays via PayPal** for INV-2. Event `INVOICING.INVOICE.PAID` appears; the reminder card turns STALE. Ask "INV-2 was just paid on PayPal. Update the plan?" → release preview → Apply. | NARRATOR: "Now the client pays. Pending requests built on the old state go stale automatically, and the agent proposes pulling the plan back to the real payment date." |
| 7 | 2:15–2:35 | Scroll the audit log; show the top-bar pills: PayPal MOCK, Agent LIVE (model name). | NARRATOR: "Every request, approval, apply and undo is in the audit log. PayPal runs as a sandbox-shaped mock in this build; the agent is a real model through the GitHub Copilot SDK, or your own key." |
| 8 | 2:35–2:45 | Outro card: repo URL, `npm install && npm start`, "MIT · Bryntum trial (watermark visible)". | NARRATOR: "Clone it and run one command. Tranche: payments that move the plan, with a human in the loop." |

Honesty rules for the recording:
- If the agent pill says SCRIPTED, the narration must not call it a real model (record a second take instead).
- The PayPal pill says MOCK; scene 7 says so out loud. Do not show "sandbox" unless M4 is built and used.
- Keep the Bryntum trial watermark visible; do not crop it out.
- Real model latency is fast-forwarded by the pipeline's `maxSilenceMs` badge ("⏩ fast-forward"), which is
  visible on screen, so the cut is disclosed.

## Render plan (reuse the existing pipeline)
The pipeline from `hackathon_amazon/video` is copied unmodified into `video/scripts/` (provenance, md5s and
licences in video/LICENSES.md; that folder stays untouched). What it does (its README): records a local URL with
Playwright driven by a declarative scene JSON, generates local Kokoro TTS, adds title/outro cards and burned-in
subtitles, and writes `out/demo.mp4` (1080p H.264/AAC), `out/preview.gif`, sample frames and JSON reports.
`record.js:105` refuses scenes estimated at ≥ 170 s, which keeps us under 3:00.

Steps (M5):
1. `cd video && npm install` (kokoro-js 1.2.1, @huggingface/transformers 3.8.0, playwright-core 1.56.1). The TTS
   model downloads on first run; re-check its licence (video/LICENSES.md) before rendering.
2. Write `video/scenes/tranche.json` from the table above. Step types the recorder supports: `goto`, `type`,
   `click`, `waitFor`, `pause`, `say`, `caption`, `scrollTo`/`reveal`, `ask` (record.js:241-277). Selectors from
   our UI: `#ask-input` + `#ask-form button[type=submit]`, `[data-prompt]`, `[data-confirmation] button[data-action=approve]`,
   `#undo`, `details.demo summary`, `#sim-invoice`, `[data-sim=payer_pays]`.
3. Start the app on a free port with a fixed seed: `PORT=4317 npm start` (repo root). Live agent: the
   yuxinshiu63 Copilot login, `caffeinate -is`, on AC power only.
4. Dry run (no recording; validates voices, selectors and the < 170 s estimate):
   `npm run video -- --dry-run --scene scenes/tranche.json --url http://127.0.0.1:4317/`
5. Render: `caffeinate -is npm run video -- --scene scenes/tranche.json --url http://127.0.0.1:4317/`
6. Review `out/sample-frame-*.png`, `out/compose-report.json` (`stepLatencies`) and `ffprobe-demo.json`
   (duration < 180 s) before uploading to YouTube (public).

Budget: ≤ 10 live turns for M5 (DESIGN §9); each take uses 2 user turns (scene 3 and scene 6).
