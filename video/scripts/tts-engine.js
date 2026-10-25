import path from 'node:path';
import fs from 'node:fs';
import { KokoroTTS, env } from 'kokoro-js';
import { CACHE_DIR, MODEL_ID, VOICES, clipPath, ensureDirs, wavDurationSeconds } from './common.js';

let modelPromise;

export async function getTts() {
  ensureDirs();
  process.env.HF_HOME = path.join(CACHE_DIR, 'hf');
  process.env.TRANSFORMERS_CACHE = path.join(CACHE_DIR, 'hf');
  env.cacheDir = path.join(CACHE_DIR, 'hf');
  env.useBrowserCache = false;
  env.allowRemoteModels = true;
  if (!modelPromise) modelPromise = KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'cpu' });
  return modelPromise;
}

export async function ensureClip(voiceRole, text) {
  if (!VOICES[voiceRole]) throw new Error(`Unknown voice role '${voiceRole}'`);
  const file = clipPath(voiceRole, text);
  if (!fs.existsSync(file)) {
    const tts = await getTts();
    const audio = await tts.generate(text, { voice: VOICES[voiceRole] });
    await audio.save(file);
  }
  return { file, durationSeconds: wavDurationSeconds(file), voiceName: VOICES[voiceRole] };
}
