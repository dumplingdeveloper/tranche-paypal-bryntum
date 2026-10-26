# Draft video render, polish pass (mock PayPal, live agent)

Status: **draft**. PayPal is the deterministic mock (pill "PayPal: MOCK" in every app frame); the narration says
"PayPal is a mock in this draft". The agent is the real model through the GitHub Copilot SDK (pill
"Agent: LIVE · Copilot · gpt-6-luna"). A sandbox version will be re-rendered once sandbox credentials exist.
The video file is not committed (`video/out/` is gitignored).

Supersedes the first draft (2026-10-26 00:02Z take, md5 `602ff146f730d297a7fb887379157cca`, 164.133333 s,
commit `f19307b`).

## Result
| | |
|---|---|
| File | `video/out/tranche-draft-mock.mp4` (copy of the pipeline's `video/out/demo.mp4`; `cmp` → identical) |
| Duration (ffprobe `format=duration`) | **166.133333 s = 2:46.13** (hard limit < 3:00; compose's own guard is < 175 s) |
| Video | H.264, **1920×1080**, 30 fps (`r_frame_rate=30/1`) |
| Audio | AAC, 48 000 Hz, 2 channels; integrated −16.1 LUFS, true peak −1.5 dBFS (compose-report.json) |
| Size | **10,412,462 bytes** (9.9 MiB), bit rate 501,402 b/s |
| md5 | **94327a94fa872c627dbe53d66607c494** |
| Recording started | 2026-10-26T10:46:16.077Z (recording-manifest.json `startedAt`) |
| TTS | kokoro-js 1.2.1, `onnx-community/Kokoro-82M-v1.0-ONNX`, `apache-2.0`, revision `1939ad2a8e416c0acfeecc08a694d14ef25f2231` (out/tts-report.json). NARRATOR `af_bella`, OWNER `am_fenrir`. 17 clips, 145.12 s of speech. No music. |
| Captions | 37 cues (out/subtitles.srt). `grep -c Narrator out/subtitles.srt` → 0; owner cues keep "Owner:". |

ffprobe (`/usr/local/bin/ffprobe -v error -show_entries format=duration,size,bit_rate:stream=codec_name,width,height,r_frame_rate,sample_rate,channels -of compact video/out/tranche-draft-mock.mp4`):
```
stream|codec_name=h264|width=1920|height=1080|r_frame_rate=30/1
stream|codec_name=aac|sample_rate=48000|channels=2|r_frame_rate=0/0
format|duration=166.133333|size=10412462|bit_rate=501402
```

## What changed against the first draft (user review items)
1. **Captions.** No speaker label on narrator lines (`captionLabel` in `video/scripts/captions.js`); "Owner:" stays.
   Captions are split per sentence, then at clause punctuation (, ; : —) choosing the fewest and most balanced
   pieces, and only at word boundaries if a single clause is still longer than 84 characters. Every cue of this
   render is listed by `awk` over out/subtitles.srt; the longest is 84 chars ("When a client pays late, they keep
   working unpaid, or they miss their own deadlines.").
2. **UNDONE.** After Undo, cf_0001 shows UNDONE with "approved by owner; undone by owner via Bryntum STM"
   (commit `7a07d15`: broker status `undone`, audit `confirmation.undone`, e2e assertion on broker state). In this
   take's audit (`video/out/take3-audit.jsonl`): 1 × `confirmation.undone`, 1 × `schedule.undone`.
3. **Re-timing of the payment section.** The scene now waits for each state before the line about it:
   click *Client pays via PayPal* → wait for the STALE reminder → show the agent panel → "The payment arrives as a
   PayPal event, and the event wakes the agent by itself." (on screen at 1:49: event `INVOICING.INVOICE.PAID`,
   "Agent is thinking…", no preview yet) → wait for the release card and the agent to go idle → "It proposes moving
   the plan to the real payment date. The dashed bars show the new dates." (1:57: release ghosts and PENDING
   cf_0003) → scroll to the STALE card → "Meanwhile, the reminder I never sent has turned stale…" (2:05).
4. **First 15 s.** Intro card (0–4 s): "For freelancers and small agencies paid in instalments: a late PayPal payment
   shouldn't mean unpaid work or a missed deadline." Narration 0:05–0:15: "Tranche is for freelancers and small
   agencies paid in instalments. When a client pays late, they keep working unpaid, or they miss their own
   deadlines." (who, the problem, why it matters).

## Live agent in this take (counted against the 35-turn build budget)
Live log `video/out/take3-live.jsonl` (2 lines, gitignored), model `gpt-6-luna`, auth `copilot-login:yuxinshiu63`:

| Turn | Trigger | Tool calls the model made (args abridged only where marked …) | Duration |
|---|---|---|---|
| t1 | owner typed "Invoice INV-2 for Acme is 9 days overdue. What does that do to the plan? Draft a reminder too." | `get_board_status {}` → `get_reminder_facts {"invoice_number":"INV-2"}` → `schedule_shift_preview {"invoice_number":"INV-2","reason":"overdue 9 days"}` → `request_schedule_change {"preview_id":"pv_shift_INV-2_2026-11-10","note_to_owner":"INV-2 is 9 days overdue; preview shifts Acme delivery using the policy-default payment date and flags a Dana booking conflict."}` → `request_payment_reminder {"invoice_number":"INV-2","friendly_note":"Hi Acme team, a friendly reminder that invoice INV-2 for €4,800 was due on October 25. …"}` | 31.6 s |
| t2 | auto-watch: `PayPal event INVOICING.INVOICE.PAID (mock-poll): INV-2 (Acme Coffee Roasters) SENT → PAID. …` | `get_board_status {}` → `schedule_release_preview {"invoice_number":"INV-2"}` → `request_schedule_change {"preview_id":"pv_release_INV-2_2026-11-03","note_to_owner":"INV-2 was paid on 2026-11-03, later than its plan date; this aligns Acme's plan to payment and flags a Dana booking conflict."}` | 14.3 s |

**Live user turns in this step: 2** (budget 2). Build total: 6 + 2 = **8 of 35**. The scripted agent was used only
for the dry run (no video) and is not counted.

## Exact commands (repo root = `hackathon_paypal_bryntum/`)
```sh
# CPU courtesy before every recording/render step (polls 60 s, max 40 min; the user's check):
#   for p in $(pgrep -f 'ffmpeg|node|python|chrom'); do lsof -a -p $p -d cwd -Fn 2>/dev/null | grep -q 'claude_folder/hackathon_paypal/video' && echo busy && break; done
PORT=4317 TRANCHE_AGENT=scripted TRANCHE_AUDIT_FILE=/tmp/tranche-video-dry-audit.jsonl npm start          # dry-run server
(cd video && node scripts/video.js --dry-run --scene scenes/tranche.json --url http://127.0.0.1:4317/)   # "Dry run OK. Estimated duration 152.5s"
# stop it by PID; pmset -g batt → "Now drawing from 'AC Power'"; busy check → clear
PORT=4317 TRANCHE_AUDIT_FILE=$PWD/video/out/take3-audit.jsonl TRANCHE_LIVE_LOG=$PWD/video/out/take3-live.jsonl caffeinate -is npm start
(cd video && HF_HOME=$PWD/.cache/hf caffeinate -is node scripts/video.js --scene scenes/tranche.json --url http://127.0.0.1:4317/)   # tts → record → compose, exit 0
# stop the live server by PID. Caption splitter then made balanced (see above); busy check → clear; compose only,
# same recording and audio, no model turn:
(cd video && caffeinate -is node scripts/compose.js --scene scenes/tranche.json && cp out/demo.mp4 out/tranche-draft-mock.mp4)
for t in 10 62 96 117 125 140; do ffmpeg -v error -y -ss $t -i video/out/tranche-draft-mock.mp4 -frames:v 1 artifacts/video-frames/frame-$(printf %03d $t)s.png; done
<asr-venv>/bin/python <session files>/asr_check.py video/out/tranche-draft-mock.mp4 video/scenes/tranche.json base.en
(cd video && node scripts/devpost-media.js)      # gallery + thumbnail from video/out/stills (see below)
```

## Fast-forward (disclosed on screen)
`maxSilenceMs` 1000: any silent stretch longer than 1 s is sped up and carries the pipeline's "⏩ fast-forward"
badge. 10 segments (compose-report.json `compressionSegments`). The two large ones are the live model working:
turn t1 after the narration ended (20.71 s → 1 s, ×20.7, video 0:55.6–0:56.6) and turn t2 (7.94 s → 1 s, ×7.9,
video 1:52.8–1:53.8). The others are 1.0–2.9 s pauses. Nothing else is cut.

## ASR check (faster-whisper base.en, the user's tool)
`# script words 370, heard words 370, ratio 0.962` (previous draft 0.941). All 12 differences are spelling
variants: instalments/installments, bryntum/brintum (×4), two/2 (×2), too/to, copilot/co pilot, every one/everyone,
any more/anymore, labelled/labeled. The transcript is in script order. Saved as `video/out/take3-asr-final.txt`;
it is identical to the run on the pre-caption-fix file (same audio).

## Frames (`artifacts/video-frames/`, fixed timestamps, all viewed)
| File | md5 | Caption at that moment | What is on screen |
|---|---|---|---|
| frame-010s.png | 89ca87c2625c9f6d6435d558d0dae886 | "When a client pays late, they keep working unpaid, or they miss their own deadlines." | Board at rest: INV-2 "9d overdue", red hatched Build bar, "blocked: INV-2", TRANCHE.INVOICE.OVERDUE event, capacity view, pills MOCK / LIVE · gpt-6-luna. |
| frame-062s.png | c407911335ee852aac79e9b0e9057bf0 | "The dashed ghost bars are that preview: the phases behind invoice two slide," | PREVIEW banner (INV-2 paid 10 Nov policy, Build +16d, Launch +9d, slips 9d, Dana double-booked); ghosts "INV-2 → 10 Nov", "INV-3 → 1 Dec"; 5 tool chips; cf_0001 and cf_0002 PENDING with payload sha256. |
| frame-096s.png | 6981ccca2c833bb0e9eda65eca78bd8b | "and the card now says undone." | Plan back at base dates; cf_0001 **UNDONE** "approved by owner; undone by owner via Bryntum STM"; cf_0002 still PENDING; Undo disabled. |
| frame-117s.png | ad1382aeb48b4b82f9da01d318d12ac3 | "It proposes moving the plan to the real payment date." | INV-2 PAID 3 Nov; release PREVIEW banner (+9d / +2d, slips 2d); ghosts "INV-2 → 3 Nov", "INV-3 → 24 Nov"; agent reply + 3 tool chips; cf_0003 PENDING; cf_0002 STALE; cf_0001 UNDONE. |
| frame-125s.png | a39dab04b4bc64bad6681e449b2857a4 | "It can't be approved any more, so nobody nags a client who just paid." | Approvals scrolled: cf_0002 STALE with reason "board changed since the preview (PayPal: INV-2 INVOICING.INVOICE.PAID …)"; cf_0003 PENDING above; events list. |
| frame-140s.png | 3ede8286b4880b54f8ce3880b04ad041 | "Every request, approval, apply, undo and PayPal event lands in the audit log." | Release applied (INV-2 3 Nov, Build 3–24 Nov, Acme end 29 Nov); Dana's Build/Rollout outlined as conflicting; audit #17–#28 (engine.verified, confirmation.approved, schedule.applied, agent.tool_call, paypal.event, confirmation.marked_stale, …); "Undo … reverts cf_0003 via Bryntum STM". |

Checks on all six and on two caption crops (0:50 "Its tools can read the board and file requests, never change
it,", 0:54 "and our scheduler, not the model, computes every date."): text readable at 1080p, no clipped labels,
trial watermark visible in every app frame, no "Narrator:" prefix, no e-mail addresses, tokens or home paths
(`grep -c @ video/out/take3-audit.jsonl` → 0). Spot frames not committed: 0:02 intro card (who/problem/why text),
1:49 (event shown, "Agent is thinking…", no preview yet).

## Where video and narration could still be read as not matching
- From the click at ≈1:42 (recording 125.33 s minus 23.15 s of earlier fast-forward) the STALE reminder card is already on screen, while the narration first talks about the
  payment event and the release preview; it is named at 2:01–2:10. Both are true at the time they are said; the
  card is just visible before it is mentioned.
- The model's thinking time is fast-forwarded (badge shown), so the preview appears faster than real time.
- "Changed my mind?" is the narrator speaking for the owner. Stylistic.

## Pipeline changes in this step
- New `video/scripts/captions.js` (MIT, new code): caption split and speaker label rules.
- `video/scripts/compose.js` (GPL-2.0-or-later): uses `captions.js` for cue text and labels.
- `video/scripts/record.js` (GPL-2.0-or-later): new `snapshot` step that writes a real page screenshot to
  `out/stills/<name>.png` (`out/stills-dry-run/` in a dry run). Used for the Devpost gallery.
- New `video/scripts/devpost-media.js` (MIT, new code): see below.
- `video/scenes/tranche.json`: new intro text, first line, re-timed payment section, UNDONE line, 5 snapshot steps,
  `maxSilenceMs` 1000.

## Devpost media (`artifacts/devpost/`, committed; `media-report.json` has sizes and md5s)
Built by `video/scripts/devpost-media.js` from the 5 stills that `record.js` wrote during this live take
(1920×940 page screenshots, not re-encoded video frames). Gallery: the still placed unscaled between a title band
(top, 200 px) and a footer band (140 px) that says "Real UI screenshot · Tranche · PayPal in mock mode · Bryntum
Gantt & SchedulerPro (trial)". Thumbnail: title band (196 px) over the still scaled to 1280 px wide; the bottom of
the still is cut by the 720 px frame. No UI pixels are edited.

| File | Size | md5 | Moment |
|---|---|---|---|
| gallery-1-01-overdue-blocks-phase.png | 1920×1280 | a21d43e830f98780ad3d5c670efcca9d | INV-2 overdue, Build blocked (red) |
| gallery-2-02-agent-preview-and-approvals.png | 1920×1280 | 53f8e2dc8ef7be794d5d33b5f16424e7 | Agent tool calls, dashed preview, two PENDING cards with payload hashes |
| gallery-3-03-applied-in-bryntum-engine.png | 1920×1280 | ae40525baa411ca86fe910b6375ea7c4 | cf_0001 APPROVED and applied; Undo via STM available; Dana conflict outlined |
| gallery-4-04-paid-reminder-stale-release-preview.png | 1920×1280 | 41ecfc53b130bb3ec20773dd4337d7fc | INV-2 PAID event; reminder STALE; release preview PENDING; cf_0001 UNDONE |
| gallery-5-05-release-applied-audit-log.png | 1920×1280 | 1de0792666c747aa779a694b6b60500c | Release applied; audit log |
| youtube-thumbnail-1280x720.png | 1280×720 | e6f2e240c5bf9fbb40fd13e323984423 | "Tranche" / "Late PayPal payment? The schedule knows." over the preview still |

All six viewed: 3:2 at 1920×1280 (≥ 1500×1000), MOCK pill and trial watermark visible, no e-mails, tokens or
home paths (the `agent.mode` audit line, which holds the login name, is truncated before that field in still 01).
