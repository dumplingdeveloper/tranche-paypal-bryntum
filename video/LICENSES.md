# video/: provenance and licences

The repository's own app code is MIT (top-level `LICENSE`). **This `video/` folder is a separate dev tool and is
not part of the app.**

## Copied scripts
Copied unmodified on 2026-10-25 from `/Users/shiyx/Downloads/claude_folder/hackathon_amazon/video/scripts/`
(the same author's project; `git log` there: all 19 commits by yuxinshiu63). That project's `video/package.json`
says `"license": "GPL-2.0-or-later"`, so these files stay **GPL-2.0-or-later** here unless the author relicenses
them. md5 of the source files at copy time (identical copies):

| File | md5 |
|---|---|
| scripts/common.js | 0216a98f0d755431ce590915072151ac |
| scripts/compose.js | 1c262e1d88d7208d181122291fd8e50d |
| scripts/record.js | c9c4b3eca685b494a75af12ea4841249 |
| scripts/tts.js | 0daa64d03ce634255aa98ecabb4cbbbd |
| scripts/tts-engine.js | 63a28bde112782fe87fb5424fde75511 |
| scripts/video-timing.js | dc3c01fe44c088005f58e954b6573d17 |
| scripts/video.js | e721a0d1a1b64938517dbfaefe7a35e3 |
| scripts/serve-static.js | 41b9ab71606dc6f6ff09f78a92806b4f |

Not copied: `node_modules/`, `out/`, `stub/`, the old scenes, `record-live.js`.

### Changed after copying (M5, 2026-10-26; still GPL-2.0-or-later)
- `scripts/compose.js`: card text from the scene (`intro`/`outro`) instead of the source project's hard-coded text;
  the `github` URL check replaced by a card-text check; the "card-bottom" sample frame clamped inside the video.
- `scripts/tts.js`: writes its licence check to `out/tts-licence-check.md` instead of overwriting this file.
- New: `scenes/tranche.json` (our scene). Details: docs/VIDEO_RENDER.md.

## Text to speech (from the source project's LICENSES.md)
- kokoro-js 1.2.1, Apache-2.0 (https://www.npmjs.com/package/kokoro-js)
- Model onnx-community/Kokoro-82M-v1.0-ONNX, `cardData.license: apache-2.0`
  (https://huggingface.co/api/models/onnx-community/Kokoro-82M-v1.0-ONNX), revision observed there
  1939ad2a8e416c0acfeecc08a694d14ef25f2231. Re-check before rendering.

## Content
No music, no third-party logos. The recording shows our own UI; the Bryntum trial watermark is left visible as
shipped.
