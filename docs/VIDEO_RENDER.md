# M5 draft video render (mock PayPal, live agent)

Status: **draft**. PayPal is the deterministic mock (pill "PayPal: MOCK" in every app frame). The agent is the real
model through the GitHub Copilot SDK (pill "Agent: LIVE · Copilot · gpt-6-luna"). A sandbox version will be
re-rendered once sandbox credentials exist. The video file itself is not committed (`video/out/` is gitignored).

## Result
| | |
|---|---|
| File | `video/out/tranche-draft-mock.mp4` (byte-identical copy of the pipeline's `video/out/demo.mp4`; `cmp` → identical) |
| Duration (ffprobe `format=duration`) | **164.133333 s = 2:44.13** (target 2:30–2:50, hard limit < 3:00) |
| Video | H.264, **1920×1080**, 30 fps (`r_frame_rate=30/1`) |
| Audio | AAC, 48 000 Hz, 2 channels; integrated loudness −16.3 LUFS, true peak −1.5 dBFS (compose-report.json) |
| Size | **10,095,503 bytes** (9.6 MiB), bit rate 492,063 b/s |
| md5 | **602ff146f730d297a7fb887379157cca** |
| Recording started | 2026-10-26T00:02:28.922Z (recording-manifest.json `startedAt`); viewport check 1920×940, dpr 1 |
| TTS | kokoro-js 1.2.1, model `onnx-community/Kokoro-82M-v1.0-ONNX`, licence re-checked via the HF API at render time: `apache-2.0`, revision `1939ad2a8e416c0acfeecc08a694d14ef25f2231` (`video/out/tts-licence-check.md`). Voices: NARRATOR `af_bella`, OWNER `am_fenrir`. 15 clips, 143.67 s of speech. No music. |

ffprobe output (`/usr/local/bin/ffprobe -v error -show_entries format=duration,size,bit_rate:stream=codec_name,codec_type,width,height,r_frame_rate,sample_rate,channels -of default=nw=1 video/out/tranche-draft-mock.mp4`):
```
codec_name=h264  codec_type=video  width=1920  height=1080  r_frame_rate=30/1
codec_name=aac   codec_type=audio  sample_rate=48000  channels=2
duration=164.133333  size=10095503  bit_rate=492063
```

## Live agent in this take (counted against the 35-turn build budget)
Live log `video/out/take1-live.jsonl` (2 lines, gitignored), model `gpt-6-luna`, auth `copilot-login:yuxinshiu63`:

| Turn | Trigger | Tool calls the model made (args abridged only where marked …) | Duration |
|---|---|---|---|
| 1 | owner typed "Invoice INV-2 for Acme is 9 days overdue. What does that do to the plan? Draft a reminder too." | `get_board_status {}` → `schedule_shift_preview {"invoice_number":"INV-2","reason":"overdue 9 days"}` → `get_reminder_facts {"invoice_number":"INV-2"}` → `request_schedule_change {"preview_id":"pv_shift_INV-2_2026-11-10","note_to_owner":"INV-2 is 9 days overdue; preview shifts Acme phases under the default 2026-11-10 payment assumption."}` → `request_payment_reminder {"invoice_number":"INV-2","friendly_note":"Hi Acme team, a friendly reminder that invoice INV-2 for €4,800.00 was due on October 25. …"}` | 22.3 s |
| 2 | auto-watch: `PayPal event INVOICING.INVOICE.PAID (mock-poll): INV-2 (Acme Coffee Roasters) SENT → PAID. …` | `get_board_status {}` → `schedule_release_preview {"invoice_number":"INV-2"}` → `request_schedule_change {"preview_id":"pv_release_INV-2_2026-11-03","note_to_owner":"INV-2 was paid on 2026-11-03; align the tranche and dependent Acme phases with the PayPal payment date."}` | 8.2 s |

**M5 live user turns: 2** (budget for this step: 6). Build total: 4 (M1–M3) + 2 = **6 of 35**. The scripted agent was
used only for the dry run (no video) and is not counted.

## Exact commands (repo root = `hackathon_paypal_bryntum/`)
```sh
cd video && npm install --no-audit --no-fund               # added 57 packages
# dry run against the scripted agent (no live turns, no video): validates selectors, flow and the < 170 s estimate
PORT=4317 TRANCHE_AGENT=scripted TRANCHE_AUDIT_FILE=/tmp/tranche-video-audit.jsonl npm start      # (repo root)
node scripts/video.js --dry-run --scene scenes/tranche.json --url http://127.0.0.1:4317/          # "Dry run OK. Estimated duration 155.8s"
HF_HOME=$PWD/.cache/hf caffeinate -i node scripts/tts.js --scene scenes/tranche.json             # 15 clips, 143.67 s audio
# stop the scripted server (kill <pid>), then start the live one:
PORT=4317 TRANCHE_AUDIT_FILE=$PWD/video/out/take1-audit.jsonl TRANCHE_LIVE_LOG=$PWD/video/out/take1-live.jsonl caffeinate -is npm start   # (repo root)
pgrep -f moneyDeskLive          # empty → go;  pmset -g batt → "Now drawing from 'AC Power'"
caffeinate -is node scripts/video.js --scene scenes/tranche.json --url http://127.0.0.1:4317/
#  → record OK ("Recorded: out/recording.webm"); compose failed at its own sample-frame step (seek past the end,
#    see "Pipeline changes"); fixed, then compose re-run on the same recording (no new model turn):
caffeinate -is node scripts/compose.js --scene scenes/tranche.json
cp out/demo.mp4 out/tranche-draft-mock.mp4
for t in 2 25 60 85 112 145; do ffmpeg -v error -y -ss $t -i video/out/tranche-draft-mock.mp4 -frames:v 1 artifacts/video-frames/frame-$(printf %03d $t)s.png; done   # (repo root)
```
The server was stopped by PID after the take.

## Fast-forward (disclosed on screen)
`maxSilenceMs` 1200: any silent stretch longer than 1.2 s is sped up and carries the pipeline's "⏩ fast-forward"
badge. 7 segments (compose-report.json `compressionSegments`), the largest is the live model's first turn after the
narration ended (9.75 s → 1.2 s, ×8.1, video 0:54.4–0:55.6). Nothing else is cut.

## Frames (`artifacts/video-frames/`, extracted at fixed timestamps, all viewed)
| File | md5 | Narration at that moment | What is on screen |
|---|---|---|---|
| frame-002s.png | d2ced2ac6ae8c8c40bc320a2c211780d | (silent title card) | Intro card: "Tranche", tagline, "Draft render. PayPal runs as a deterministic, sandbox-shaped mock in this video." |
| frame-025s.png | 934464f246fd60608c4b857b37823d68 | "…unlocks is blocked, in red. The team capacity view below is a…" | Board at rest: INV-2 card "9d overdue", red hatched Build bar, "blocked: INV-2" chip, capacity view; pills MOCK / LIVE · gpt-6-luna; audit "Bryntum engine ✓ 12/12 dates match". |
| frame-060s.png | bfce8a9ca2eb8565dd4f62d4bdbfe562 | "The dashed ghost bars are that preview. The phases behind invoice…" | PREVIEW banner (INV-2 paid 10 Nov policy, Build +16d, Launch +9d, slips 9d, Dana double-booked), dashed ghosts "INV-2 → 10 Nov", "INV-3 → 1 Dec"; agent tool chips; two PENDING cards with payload sha256. |
| frame-085s.png | 142f009b769580e850f22a02bc293bf7 | "Apply runs inside the Bryntum engine as one transaction. The…" | Plan moved (INV-2 10 Nov, Build 10 Nov–1 Dec, Acme end 6 Dec); cf_0001 APPROVED; Dana's Build/Rollout outlined as conflicting; "Undo last applied change — reverts cf_0001 via Bryntum STM". |
| frame-112s.png | 2a768d1eb61264ac6f3a8c7e0f17c980 | "The paid event arrives, and the reminder I never sent turns stale." | INV-2 card PAID (paid 3 Nov); reminder cf_0002 STALE with the reason; event `INVOICING.INVOICE.PAID (mock-poll)`; the auto-woken agent is already "calling schedule_release_preview…" and its release ghosts are shown. |
| frame-145s.png | 8291550f8fd63b57267a8a4abe4660b2 | "…draft, and the agent is a live model through the GitHub Copilot…" | Release applied (INV-2 3 Nov, Build 3 Nov–24 Nov); cf_0003 APPROVED; audit log #16–#27 (engine.verified, confirmation.approved, agent.tool_call …); pills MOCK and LIVE. |

Checks on all six: text readable at 1080p, no clipped labels, trial watermark visible in every app frame, no e-mail
addresses, tokens or home paths on screen (`grep -c @ video/out/take1-audit.jsonl` → 0; the audit panel lines are
the same entries, truncated). The compose step's own grey-band pixel checks passed.

## Where video and narration could be read as not matching
- At 1:47–1:57 the narration says "the paid event arrives … turns stale" and only then "the payment event also wakes
  the agent". On screen the agent had already woken (it runs in parallel) and its release preview is visible during
  the first sentence. The order of the two sentences is the only difference; both statements are true.
- After Undo (≈1:31–1:39) cf_0001 still says APPROVED (the card shows the approval, not the later undo); the plan itself
  is back to the base dates and the audit has `schedule.undone`. The narration only claims the plan is back.
- The narrator says "Changed my mind?" in the first person for the owner. Stylistic only.

## Pipeline changes for Tranche (video/scripts, GPL-2.0-or-later, see video/LICENSES.md)
- `compose.js`: intro/outro card text comes from the scene (`intro`, `outro`) instead of hard-coded Tillwise/Alexa
  text; the `github` URL requirement is replaced by "card text must exist and must not say placeholder" (the repo
  is not published yet, so the outro says "Repository link: on the Devpost page"); the "card-bottom" sample frame is
  clamped inside the video (the original seeked past the end and ffmpeg wrote no file).
- `tts.js`: writes its licence check to `out/tts-licence-check.md` instead of overwriting `video/LICENSES.md`.
- `video/.gitignore`: adds `.cache/` (raw Playwright recordings, 17 MB after this take). The Kokoro model itself was
  cached by transformers.js under `video/node_modules/@huggingface/transformers/.cache/` (ignored with node_modules).
- `video/scenes/tranche.json`: new scene (narration is in this file; it supersedes the draft lines in
  docs/VIDEO_SCRIPT.md where they differ).
