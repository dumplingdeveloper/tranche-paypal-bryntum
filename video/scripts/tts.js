import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { KokoroTTS, env } from 'kokoro-js';
import { AUDIO_DIR, CACHE_DIR, HF_MODEL_API, MODEL_ID, OUT_DIR, VOICES, clipId, collectSayLines, ensureDirs, parseArgs, readScene, rel } from './common.js';

const PERMISSIVE = new Set(['apache-2.0', 'mit', 'bsd-2-clause', 'bsd-3-clause', 'isc', 'cc0-1.0']);

async function verifyLicense() {
  const res = await fetch(HF_MODEL_API);
  if (!res.ok) throw new Error(`HF API license check failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const license = data.cardData?.license;
  if (!PERMISSIVE.has(String(license).toLowerCase())) {
    throw new Error(`Model repo ${MODEL_ID} license '${license}' is not in the permissive allow-list; stopping.`);
  }
  return { repo: data.id || MODEL_ID, license, sha: data.sha, url: `https://huggingface.co/${MODEL_ID}` };
}

function writeLicenses(facts) {
  const voiceNotes = [
    ['NARRATOR', VOICES.NARRATOR, 'American English female, target quality A, overall grade A- in the kokoro-js voice table.'],
    ['OWNER', VOICES.OWNER, 'American English male, target quality B, overall grade C+ in the kokoro-js voice table.'],
    ['ASSISTANT', VOICES.ASSISTANT, 'American English female, overall grade A in the kokoro-js voice table.'],
    ['HOST', VOICES.HOST, 'British English female, target quality B, overall grade B- in the kokoro-js voice table.']
  ];
  const md = `# Demo video license record\n\n` +
    `No music, third-party logos, brand assets, or copyrighted media are used by this pipeline. All cards and UI in the stub are original HTML/CSS.\n\n` +
    `## Text to speech\n\n` +
    `- Library: kokoro-js 1.2.1, Apache-2.0, https://www.npmjs.com/package/kokoro-js\n` +
    `- ONNX model repo checked through the Hugging Face API: ${facts.repo}\n` +
    `- API URL: ${HF_MODEL_API}\n` +
    `- Model page: ${facts.url}\n` +
    `- cardData.license: ${facts.license}\n` +
    `- Revision observed: ${facts.sha}\n\n` +
    `## Voices\n\n` +
    voiceNotes.map(([role, name, why]) => `- ${role}: \`${name}\` — ${why}`).join('\n') +
    `\n\nVoice quality source: kokoro-js README/model-card voice table, https://huggingface.co/${MODEL_ID}#samples\n`;
  fs.writeFileSync(path.join(path.dirname(OUT_DIR), 'LICENSES.md'), md);
}

function wavDurationSeconds(file) {
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

async function main() {
  ensureDirs();
  process.env.HF_HOME = path.join(CACHE_DIR, 'hf');
  process.env.TRANSFORMERS_CACHE = path.join(CACHE_DIR, 'hf');
  env.cacheDir = path.join(CACHE_DIR, 'hf');
  env.useBrowserCache = false;
  env.allowRemoteModels = true;

  const args = parseArgs();
  const scene = readScene(args.scene);
  const lines = collectSayLines(scene);
  const facts = await verifyLicense();
  writeLicenses(facts);

  console.log(`License OK: ${facts.repo} ${facts.license}`);
  console.log(`Loading ${MODEL_ID} into ${rel(env.cacheDir)} ...`);
  const loadStart = performance.now();
  const tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'cpu' });
  const loadSeconds = (performance.now() - loadStart) / 1000;

  const generated = [];
  let genSeconds = 0;
  let audioSeconds = 0;
  for (const line of lines) {
    const id = clipId(line.voice, line.text);
    if (fs.existsSync(line.path)) {
      const dur = wavDurationSeconds(line.path);
      generated.push({ ...line, id, cached: true, durationSeconds: dur, generationSeconds: 0, realtimeFactor: 0 });
      audioSeconds += dur;
      console.log(`cache hit ${id} ${line.voice}/${line.voiceName}: ${rel(line.path)}`);
      continue;
    }
    const start = performance.now();
    const audio = await tts.generate(line.text, { voice: line.voiceName });
    await audio.save(line.path);
    const seconds = (performance.now() - start) / 1000;
    const dur = wavDurationSeconds(line.path);
    genSeconds += seconds;
    audioSeconds += dur;
    generated.push({ ...line, id, cached: false, durationSeconds: dur, generationSeconds: seconds, realtimeFactor: dur ? seconds / dur : null });
    console.log(`generated ${id} ${line.voice}/${line.voiceName}: ${dur.toFixed(2)}s audio in ${seconds.toFixed(2)}s`);
  }

  const report = {
    model: facts,
    voices: VOICES,
    lineCount: lines.length,
    loadSeconds,
    generatedAudioSeconds: audioSeconds,
    uncachedGenerationSeconds: genSeconds,
    uncachedRealtimeFactor: audioSeconds ? genSeconds / audioSeconds : 0,
    cacheDir: rel(CACHE_DIR),
    clips: generated.map(g => ({ index: g.index, id: g.id, voice: g.voice, voiceName: g.voiceName, text: g.text, path: rel(g.path), cached: g.cached, durationSeconds: g.durationSeconds, generationSeconds: g.generationSeconds, realtimeFactor: g.realtimeFactor }))
  };
  fs.writeFileSync(path.join(OUT_DIR, 'tts-report.json'), JSON.stringify(report, null, 2));
  console.log(`TTS report: ${rel(path.join(OUT_DIR, 'tts-report.json'))}`);
  console.log(`TTS speed: ${audioSeconds.toFixed(2)}s audio / ${genSeconds.toFixed(2)}s uncached generation = ${(audioSeconds / Math.max(genSeconds, 0.001)).toFixed(2)}x realtime (${(genSeconds / Math.max(audioSeconds, 0.001)).toFixed(2)} RTF)`);
}

main().catch(err => { console.error(err); process.exit(1); });
