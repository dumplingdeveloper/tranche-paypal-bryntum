import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE_DIR = path.join(ROOT, '.cache');
export const OUT_DIR = path.join(ROOT, 'out');
export const AUDIO_DIR = path.join(OUT_DIR, 'audio');
export const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const HF_MODEL_API = `https://huggingface.co/api/models/${MODEL_ID}`;
export const VOICES = {
  NARRATOR: 'af_bella',
  OWNER: 'am_fenrir',
  ASSISTANT: 'af_heart',
  HOST: 'bf_emma'
};

export function ensureDirs() {
  for (const dir of [CACHE_DIR, OUT_DIR, AUDIO_DIR, path.join(CACHE_DIR, 'hf'), path.join(CACHE_DIR, 'videos')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) args[key] = true;
      else args[key] = argv[++i];
    }
  }
  return args;
}

export function readScene(scenePath) {
  const abs = path.resolve(ROOT, scenePath || 'scenes/example.json');
  const scene = JSON.parse(fs.readFileSync(abs, 'utf8'));
  scene.__path = abs;
  return scene;
}

export function clipId(voiceRole, text) {
  return crypto.createHash('sha256').update(`${voiceRole}\0${VOICES[voiceRole] || voiceRole}\0${text}`).digest('hex').slice(0, 20);
}

export function clipPath(voiceRole, text) {
  return path.join(AUDIO_DIR, `${clipId(voiceRole, text)}.wav`);
}

export function collectSayLines(scene) {
  const lines = [];
  let index = 0;
  for (const step of scene.steps || []) {
    const isSay = step.action === 'say';
    const isOwnerTurn = step.action === 'ask' || step.action === 'confirm';
    if (isSay || isOwnerTurn) {
      const voice = isOwnerTurn ? (step.voice || 'OWNER') : step.voice;
      if (!VOICES[voice]) throw new Error(`Unknown voice role '${voice}' in scene`);
      if (!step.text) throw new Error(`${step.action} step is missing text`);
      lines.push({ index: index++, voice, voiceName: VOICES[voice], text: step.text, path: clipPath(voice, step.text) });
    }
  }
  return lines;
}

export function wavDurationSeconds(file) {
  const b = fs.readFileSync(file);
  const idx = b.indexOf(Buffer.from('data'));
  if (idx < 0) return 0;
  const dataBytes = b.readUInt32LE(idx + 4);
  const fmt = b.indexOf(Buffer.from('fmt '));
  const channels = b.readUInt16LE(fmt + 10);
  const sampleRate = b.readUInt32LE(fmt + 12);
  const bitsPerSample = b.readUInt16LE(fmt + 22);
  return dataBytes / (sampleRate * channels * (bitsPerSample / 8));
}

export function rel(p) {
  return path.relative(ROOT, p) || '.';
}
