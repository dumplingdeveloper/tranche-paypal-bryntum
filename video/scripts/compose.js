import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { OUT_DIR, ROOT, ensureDirs, parseArgs, readScene, rel } from './common.js';

const FFMPEG = '/usr/local/bin/ffmpeg';
const FFPROBE = '/usr/local/bin/ffprobe';
const INTRO_SECONDS = 4;
const OUTRO_SECONDS = 4;
const FRAME_WIDTH = 1920;
const FRAME_HEIGHT = 1080;
const DARK_BG = '0x07111f';

function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`${cmd} failed\n${res.stdout}\n${res.stderr}`);
  return res.stdout.trim();
}

function runCapture(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`${cmd} failed\n${res.stdout}\n${res.stderr}`);
  return `${res.stdout}\n${res.stderr}`;
}

function probeDuration(file) {
  return Number(run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]));
}

function ts(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function escSrt(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function readRgbFrame(inputArgs) {
  const res = spawnSync(FFMPEG, ['-v', 'error', ...inputArgs, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: FRAME_WIDTH * FRAME_HEIGHT * 3 + 1024 * 1024
  });
  if (res.status !== 0) throw new Error(`${FFMPEG} pixel read failed\n${res.stderr}`);
  const expected = FRAME_WIDTH * FRAME_HEIGHT * 3;
  if (res.stdout.length < expected) throw new Error(`Pixel read returned ${res.stdout.length} bytes, expected ${expected}`);
  return res.stdout;
}

function greyAt(buf, x, y) {
  const i = (y * FRAME_WIDTH + x) * 3;
  const r = buf[i], g = buf[i + 1], b = buf[i + 2];
  return r >= 105 && r <= 145 && g >= 105 && g <= 145 && b >= 105 && b <= 145 && Math.max(r, g, b) - Math.min(r, g, b) <= 18;
}

function checkNoGreyBand(label, inputArgs, contentHeight) {
  const buf = readRgbFrame(inputArgs);
  const xs = [80, 200, 480, 960, 1440, 1840];
  let runStart = null;
  let runLength = 0;
  for (let y = 0; y < contentHeight; y++) {
    const greyColumns = xs.filter(x => greyAt(buf, x, y)).length;
    if (greyColumns >= xs.length - 1) {
      if (runStart == null) runStart = y;
      runLength++;
      if (runLength >= 10) {
        throw new Error(`Grey letterbox/padding band detected in ${label}: y=${runStart}..${y} within content area 0..${contentHeight - 1}`);
      }
    } else {
      runStart = null;
      runLength = 0;
    }
  }
  return { label, sampledColumns: xs, contentRowsChecked: contentHeight, ok: true };
}

function firstChars(text, n = 40) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function assertNoTemporalOverlaps(items, label, toleranceSeconds = 0.05) {
  const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
  const checks = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const gap = cur.start - prev.end;
    checks.push({ previous: prev.id, current: cur.id, gapSeconds: Number(gap.toFixed(3)), ok: gap >= -toleranceSeconds });
    if (gap < -toleranceSeconds) {
      throw new Error(`${label} overlap: ${prev.id} (${prev.start.toFixed(3)}-${prev.end.toFixed(3)}) overlaps ${cur.id} (${cur.start.toFixed(3)}-${cur.end.toFixed(3)}) by ${(-gap).toFixed(3)}s`);
    }
  }
  return checks;
}

function speakerLabel(event) {
  const role = String(event.role || event.voice || '').toLowerCase();
  if (role === 'owner') return 'Owner';
  if (role === 'narrator') return 'Narrator';
  if (role === 'host') return 'Host';
  return 'Assistant';
}

// Title and outro cards are protected ranges: they are never sped up, even though they are silent.
function buildCompressionSegments(audioTimeline, duration, maxSilenceSeconds, protectedRanges = []) {
  const audio = [
    ...audioTimeline.map(clip => ({ start: clip.start, end: clip.end, type: 'audio' })),
    ...protectedRanges.map(range => ({ start: range.start, end: range.end, type: 'card' }))
  ].sort((a, b) => a.start - b.start);
  const segments = [];
  let cursor = 0;
  for (const clip of audio) {
    if (clip.start > cursor) segments.push({ type: 'silence', originalStart: cursor, originalEnd: clip.start });
    const start = Math.max(clip.start, cursor);
    if (clip.end > start) segments.push({ type: clip.type, originalStart: start, originalEnd: clip.end });
    cursor = Math.max(cursor, clip.end);
  }
  if (cursor < duration) segments.push({ type: 'silence', originalStart: cursor, originalEnd: duration });
  let compressedCursor = 0;
  for (const seg of segments) {
    const originalDuration = Math.max(0, seg.originalEnd - seg.originalStart);
    const compressedDuration = seg.type === 'silence' && originalDuration > maxSilenceSeconds ? maxSilenceSeconds : originalDuration;
    seg.originalDuration = originalDuration;
    seg.compressedDuration = compressedDuration;
    seg.factor = compressedDuration > 0 ? originalDuration / compressedDuration : 1;
    seg.spedUp = seg.type === 'silence' && seg.factor > 1.001;
    seg.compressedStart = compressedCursor;
    seg.compressedEnd = compressedCursor + compressedDuration;
    compressedCursor = seg.compressedEnd;
  }
  return segments;
}

function mapTime(segments, originalTime) {
  const seg = segments.find(s => originalTime >= s.originalStart - 0.0001 && originalTime <= s.originalEnd + 0.0001) || segments.at(-1);
  if (!seg) return originalTime;
  return seg.compressedStart + Math.max(0, originalTime - seg.originalStart) / seg.factor;
}

async function renderBadge(text, png, bandHeight, browser = null) {
  const safe = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${FRAME_WIDTH}px;height:${bandHeight}px;background:transparent;font-family:Arial,Helvetica,sans-serif}
    .badge{position:absolute;left:28px;top:50%;transform:translateY(-50%);color:#dbeafe;background:rgba(4,8,18,.78);border:1px solid rgba(148,204,255,.28);border-radius:999px;padding:10px 16px;font-size:24px;font-weight:800;box-shadow:0 8px 30px rgba(0,0,0,.28)}
  </style></head><body><div class="badge">${safe}</div></body></html>`;
  const ownBrowser = !browser;
  if (!browser) browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: FRAME_WIDTH, height: bandHeight }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  const bbox = await page.locator('.badge').boundingBox();
  if (!bbox || bbox.y < 0 || bbox.y + bbox.height > bandHeight) {
    await page.close();
    if (ownBrowser) await browser.close();
    throw new Error(`Badge bounding box is outside reserved band image: ${JSON.stringify(bbox)} bandHeight=${bandHeight}`);
  }
  await page.screenshot({ path: png, type: 'png', omitBackground: true, timeout: 0 });
  await page.close();
  if (ownBrowser) await browser.close();
  return bbox;
}

async function renderCard(html, png) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: png, type: 'png' });
  await browser.close();
}

function wrapCaption(text, maxChars = 44) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function splitCaption(text, maxLines = 2, maxChars = 44) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const segments = [];
  let current = [];
  for (const word of words) {
    const candidate = [...current, word].join(' ');
    if (current.length && wrapCaption(candidate, maxChars).length > maxLines) {
      segments.push(current.join(' '));
      current = [word];
    } else {
      current.push(word);
    }
  }
  if (current.length) segments.push(current.join(' '));
  return segments.length ? segments : [''];
}

async function renderSubtitle(text, png, bandHeight, browser = null) {
  const safe = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${FRAME_WIDTH}px;height:${bandHeight}px;background:transparent;font-family:Arial,Helvetica,sans-serif}
    .band{position:absolute;left:0;top:0;width:${FRAME_WIDTH}px;height:${bandHeight}px;display:grid;place-items:center}
    .sub{max-width:1660px;max-height:${bandHeight - 20}px;text-align:center;color:#fff;background:rgba(4,8,18,.72);border-radius:16px;padding:12px 24px;font-size:34px;line-height:1.16;font-weight:800;text-shadow:0 2px 8px #000}
  </style></head><body><div class="sub">${safe}</div></body></html>`;
  const ownBrowser = !browser;
  if (!browser) browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: FRAME_WIDTH, height: bandHeight }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => {
    const sub = document.querySelector('.sub');
    const band = document.createElement('div');
    band.className = 'band';
    sub.replaceWith(band);
    band.appendChild(sub);
  });
  const bbox = await page.locator('.sub').boundingBox();
  if (!bbox || bbox.y < 0 || bbox.y + bbox.height > bandHeight) {
    await page.close();
    if (ownBrowser) await browser.close();
    throw new Error(`Subtitle bounding box is outside reserved band image: ${JSON.stringify(bbox)} bandHeight=${bandHeight}`);
  }
  await page.screenshot({ path: png, type: 'png', omitBackground: true, timeout: 0 });
  await page.close();
  if (ownBrowser) await browser.close();
  return bbox;
}

function cardHtml(kind, scene) {
  const title = scene.projectName || 'Store Owner Voice Agent';
  const tagline = scene.tagline || 'Voice-guided WooCommerce operations with transparent MCP actions';
  const github = scene.github || '<repo-url placeholder>';
  const main = kind === 'intro' ? title : 'Thanks for watching';
  const sub = kind === 'intro' ? tagline : 'GitHub: ' + github;
  const note = kind === 'intro' ? '' : '<div class="note">The Alexa+ experience simulator is an unofficial demo, not an Amazon product.</div>';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;width:1920px;height:1080px;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:white;background:radial-gradient(circle at 20% 20%,#5755ff 0,#1b2258 34%,#091226 72%);display:grid;place-items:center;overflow:hidden}
    .orb{position:absolute;width:720px;height:720px;border-radius:50%;background:linear-gradient(135deg,#67e8f9,#a78bfa,#f0abfc);filter:blur(18px);opacity:.28;right:-180px;top:-160px}.card{width:1320px;padding:86px 98px;border:1px solid rgba(255,255,255,.22);border-radius:48px;background:rgba(8,15,35,.62);box-shadow:0 40px 140px rgba(0,0,0,.45)}
    .eyebrow{letter-spacing:.22em;text-transform:uppercase;color:#a7f3d0;font-size:28px;font-weight:800}.title{font-size:92px;line-height:1.02;margin:30px 0 24px;font-weight:900}.sub{font-size:40px;line-height:1.35;color:#dbeafe}.note{font-size:25px;line-height:1.35;color:#bfdbfe;margin-top:30px}.rule{height:6px;width:220px;border-radius:9px;background:#38bdf8;margin-top:54px}
  </style></head><body><div class="orb"></div><section class="card"><div class="eyebrow">Build, Ship, Shape demo video</div><div class="title">${main}</div><div class="sub">${sub}</div>${note}<div class="rule"></div></section></body></html>`;
}

async function main() {
  ensureDirs();
  const args = parseArgs();
  const scene = readScene(args.scene);
  const bandHeight = Number(args['subtitle-band-height'] || scene.subtitleBandHeight || 140);
  const maxSilenceSeconds = Number(args.maxSilenceMs || scene.maxSilenceMs || 1500) / 1000;
  const github = String(scene.github || '');
  if (!github || /placeholder/i.test(github)) throw new Error('Scene github must be a real URL and must not be empty or contain "placeholder".');
  const contentHeight = FRAME_HEIGHT - bandHeight;
  if (contentHeight < 600 || bandHeight < 80) throw new Error(`Invalid subtitle band height: ${bandHeight}`);
  const manifestPath = path.join(OUT_DIR, 'recording-manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('Missing out/recording-manifest.json; run record first.');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const recording = path.join(ROOT, manifest.video);
  if (!fs.existsSync(recording)) throw new Error(`Missing recording: ${recording}`);

  const introPng = path.join(OUT_DIR, 'intro.png');
  const outroPng = path.join(OUT_DIR, 'outro.png');
  await renderCard(cardHtml('intro', scene), introPng);
  await renderCard(cardHtml('outro', scene), outroPng);

  const introMp4 = path.join(OUT_DIR, 'intro.mp4');
  const recMp4 = path.join(OUT_DIR, 'recording-normalized.mp4');
  const outroMp4 = path.join(OUT_DIR, 'outro.mp4');
  const baseMp4 = path.join(OUT_DIR, 'base.mp4');
  const demoMp4 = path.join(OUT_DIR, 'demo.mp4');

  run(FFMPEG, ['-y', '-loop', '1', '-i', introPng, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', String(INTRO_SECONDS), '-vf', `fps=30,scale=${FRAME_WIDTH}:${FRAME_HEIGHT},format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-shortest', introMp4]);
  run(FFMPEG, ['-y', '-i', recording, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-vf', `fps=30,scale=${FRAME_WIDTH}:${contentHeight},pad=${FRAME_WIDTH}:${FRAME_HEIGHT}:0:0:color=${DARK_BG},format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-shortest', recMp4]);
  run(FFMPEG, ['-y', '-loop', '1', '-i', outroPng, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', String(OUTRO_SECONDS), '-vf', `fps=30,scale=${FRAME_WIDTH}:${FRAME_HEIGHT},format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-shortest', outroMp4]);
  run(FFMPEG, ['-y', '-i', introMp4, '-i', recMp4, '-i', outroMp4, '-filter_complex', '[0:v][0:a][1:v][1:a][2:v][2:a]concat=n=3:v=1:a=1[v][a]', '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', baseMp4]);
  const baseDuration = probeDuration(baseMp4);

  const audioEvents = manifest.events.filter(e => (e.action === 'say' || e.action === 'dynamicSpeak') && (e.clipPath || e.file));
  const subtitleEvents = manifest.events.filter(e => e.action === 'say' || e.action === 'caption' || e.action === 'dynamicSpeak');
  let srt = '';
  const audioInputs = [];
  const subtitleInputs = [];
  const audioFilters = [];
  const videoFilters = [];
  const mixLabels = ['[0:a]'];
  const subtitleOverlays = [];
  const audioDurations = new Map();
  const timeline = [];
  for (let i = 0; i < audioEvents.length; i++) {
    const e = audioEvents[i];
    const wav = path.join(ROOT, e.clipPath || e.file);
    if (!fs.existsSync(wav)) throw new Error(`Missing TTS clip for subtitle/audio mix: ${e.clipPath || e.file}`);
    const dur = probeDuration(wav);
    audioDurations.set(e, dur);
    const start = INTRO_SECONDS + e.at;
    const end = start + dur;
    timeline.push({
      id: `audio-${i + 1}`,
      start,
      end,
      role: e.role || e.voice || 'caption',
      action: e.action,
      text: e.text,
      file: e.clipPath || e.file,
      wav
    });
  }
  const originalAudioOverlapChecks = assertNoTemporalOverlaps(timeline, 'Audio');
  const compressionSegments = buildCompressionSegments(timeline, baseDuration, maxSilenceSeconds, [
    { start: 0, end: INTRO_SECONDS },
    { start: Math.max(0, baseDuration - OUTRO_SECONDS), end: baseDuration }
  ]);
  for (const item of timeline) {
    item.originalStart = item.start;
    item.originalEnd = item.end;
    item.start = mapTime(compressionSegments, item.originalStart);
    item.end = mapTime(compressionSegments, item.originalEnd);
  }
  const compressedDuration = compressionSegments.at(-1)?.compressedEnd || baseDuration;
  const compressedBaseMp4 = path.join(OUT_DIR, 'base-compressed.mp4');
  const segmentFilters = [];
  const segmentLabels = [];
  compressionSegments.forEach((seg, i) => {
    const label = `[cv${i}]`;
    segmentFilters.push(`[0:v]trim=start=${seg.originalStart.toFixed(3)}:end=${seg.originalEnd.toFixed(3)},setpts=(PTS-STARTPTS)/${seg.factor.toFixed(6)}${label}`);
    segmentLabels.push(label);
  });
  const compressFilter = segmentFilters.concat(`${segmentLabels.join('')}concat=n=${segmentLabels.length}:v=1:a=0[cvout]`).join(';');
  run(FFMPEG, ['-y', '-i', baseMp4, '-f', 'lavfi', '-t', String(compressedDuration), '-i', 'anullsrc=r=48000:cl=stereo', '-filter_complex', compressFilter, '-map', '[cvout]', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', compressedBaseMp4]);
  let idx = 1;
  for (const item of timeline) {
    audioInputs.push('-i', item.wav);
    const delay = Math.round(item.start * 1000);
    audioFilters.push(`[${idx}:a]adelay=${delay}|${delay},volume=1.15[a${idx}]`);
    mixLabels.push(`[a${idx}]`);
    idx++;
  }
  const subtitleBrowser = await chromium.launch({ channel: 'chrome', headless: true });
  for (let i = 0; i < subtitleEvents.length; i++) {
    const e = subtitleEvents[i];
    const dur = audioDurations.get(e) || (e.durationMs ? e.durationMs / 1000 : e.durationSeconds || 2.2);
    const originalStart = INTRO_SECONDS + e.at;
    const originalEnd = originalStart + Math.max(dur, 1.2);
    const start = mapTime(compressionSegments, originalStart);
    const endMapped = mapTime(compressionSegments, originalEnd);
    const mappedDur = Math.max(0.001, endMapped - start);
    const label = speakerLabel(e);
    const segments = splitCaption(e.text, 2, 34);
    const weights = segments.map(s => Math.max(1, s.split(/\s+/).filter(Boolean).length));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let cursor = start;
    for (let j = 0; j < segments.length; j++) {
      const segDur = Math.max(0.4, mappedDur * weights[j] / totalWeight);
      const end = j === segments.length - 1 ? endMapped : Math.min(endMapped, cursor + segDur);
      const subtitleNumber = subtitleOverlays.length + 1;
      const captionText = `${label}: ${segments[j]}`;
      srt += `${subtitleNumber}\n${ts(cursor)} --> ${ts(end)}\n${escSrt(captionText)}\n\n`;
      const png = path.join(OUT_DIR, `subtitle-${subtitleNumber}.png`);
      const bbox = await renderSubtitle(captionText, png, bandHeight, subtitleBrowser);
      subtitleInputs.push('-loop', '1', '-framerate', '30', '-i', png);
      const clipStart = e.action === 'caption' ? null : start;
      const clipEnd = e.action === 'caption' ? null : endMapped;
      subtitleOverlays.push({ id: `subtitle-${subtitleNumber}`, inputIndex: null, action: e.action, start: cursor, end, path: rel(png), text: captionText, bbox, clipStart, clipEnd, originalStart, originalEnd });
      cursor = end;
    }
  }
  await subtitleBrowser.close();
  const audioOverlapChecks = assertNoTemporalOverlaps(timeline, 'Audio');
  const captionOverlapChecks = assertNoTemporalOverlaps(subtitleOverlays, 'Caption', 0);
  const captionClipChecks = subtitleOverlays
    .filter(s => s.clipStart != null && s.clipEnd != null)
    .map(s => {
      const ok = s.start >= s.clipStart - 0.001 && s.end <= s.clipEnd + 0.001;
      if (!ok) throw new Error(`Caption ${s.id} (${s.start.toFixed(3)}-${s.end.toFixed(3)}) is outside clip (${s.clipStart.toFixed(3)}-${s.clipEnd.toFixed(3)})`);
      return { id: s.id, ok: true };
    });
  const timelineTable = timeline
    .sort((a, b) => a.start - b.start)
    .map(item => ({
      start: Number(item.start.toFixed(3)),
      end: Number(item.end.toFixed(3)),
      role: item.role,
      text: firstChars(item.text)
    }));
  const srtPath = path.join(OUT_DIR, 'subtitles.srt');
  fs.writeFileSync(srtPath, srt);
  const badgeOverlays = [];
  const badgeInputs = [];
  const badgeBrowser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const seg of compressionSegments.filter(s => s.spedUp)) {
    const badgeNumber = badgeOverlays.length + 1;
    const text = "⏩ fast-forward";
    const png = path.join(OUT_DIR, `speed-badge-${badgeNumber}.png`);
    const bbox = await renderBadge(text, png, bandHeight, badgeBrowser);
    badgeInputs.push('-loop', '1', '-framerate', '30', '-i', png);
    badgeOverlays.push({ id: `speed-badge-${badgeNumber}`, start: seg.compressedStart, end: seg.compressedEnd, path: rel(png), text, bbox, segment: seg });
  }
  await badgeBrowser.close();
  const firstSubtitleInput = 1 + audioEvents.length;
  const firstBadgeInput = firstSubtitleInput + subtitleOverlays.length;
  let currentVideo = '[0:v]';
  for (let i = 0; i < subtitleOverlays.length; i++) {
    const inputIndex = firstSubtitleInput + i;
    const out = `[vsub${i}]`;
    videoFilters.push(`${currentVideo}[${inputIndex}:v]overlay=0:${FRAME_HEIGHT - bandHeight}:enable='between(t,${subtitleOverlays[i].start.toFixed(3)},${subtitleOverlays[i].end.toFixed(3)})'${out}`);
    currentVideo = out;
  }
  for (let i = 0; i < badgeOverlays.length; i++) {
    const inputIndex = firstBadgeInput + i;
    const out = `[vbadge${i}]`;
    videoFilters.push(`${currentVideo}[${inputIndex}:v]overlay=0:${FRAME_HEIGHT - bandHeight}:enable='between(t,${badgeOverlays[i].start.toFixed(3)},${badgeOverlays[i].end.toFixed(3)})'${out}`);
    currentVideo = out;
  }
  const complex = [
    ...audioFilters,
    `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`,
    ...videoFilters
  ].join(';');
  run(FFMPEG, ['-y', '-i', compressedBaseMp4, ...audioInputs, ...subtitleInputs, ...badgeInputs, '-filter_complex', complex, '-map', currentVideo, '-map', '[aout]', '-t', String(compressedDuration), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-b:a', '192k', '-movflags', '+faststart', demoMp4]);

  const duration = probeDuration(demoMp4);
  const probe = run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate', '-of', 'json', demoMp4]);
  const loudnessOutput = runCapture(FFMPEG, ['-hide_banner', '-nostats', '-i', demoMp4, '-filter:a', 'ebur128=peak=true', '-f', 'null', '-']);
  const loudnessMatch = loudnessOutput.match(/Integrated loudness:\s*I:\s*(-?\d+(?:\.\d+)?) LUFS[\s\S]*?True peak:\s*Peak:\s*(-?\d+(?:\.\d+)?) dBFS/);
  const loudness = loudnessMatch ? { integratedLufs: Number(loudnessMatch[1]), truePeakDbfs: Number(loudnessMatch[2]) } : { raw: loudnessOutput.slice(-2000) };
  fs.writeFileSync(path.join(OUT_DIR, 'ffprobe-demo.json'), probe + '\n');
  if (duration >= 175) {
    console.log('Timeline:');
    for (const row of timelineTable) console.log(`${row.start.toFixed(3)}-${row.end.toFixed(3)} ${String(row.role).padEnd(9)} ${row.text}`);
    throw new Error(`Demo is ${duration}s, not under 175s.`);
  }
  if (!JSON.parse(probe).streams.some(s => s.codec_type === 'audio')) throw new Error('Demo has no audio stream.');

  const gif = path.join(OUT_DIR, 'preview.gif');
  run(FFMPEG, ['-y', '-t', '20', '-i', demoMp4, '-vf', 'fps=5,scale=640:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96[p];[s1][p]paletteuse=dither=bayer', '-loop', '0', gif]);
  const gifBytes = fs.statSync(gif).size;
  if (gifBytes > 5 * 1024 * 1024) throw new Error(`GIF preview is ${(gifBytes / 1024 / 1024).toFixed(2)} MB, over 5 MB.`);

  const total = duration;
  const frameTimes = [0.15, 0.35, 0.6, 0.85].map(f => Math.max(0.1, total * f));
  const frames = [];
  for (let i = 0; i < frameTimes.length; i++) {
    const png = path.join(OUT_DIR, `sample-frame-${i + 1}.png`);
    run(FFMPEG, ['-y', '-ss', String(frameTimes[i]), '-i', demoMp4, '-frames:v', '1', png]);
    frames.push(rel(png));
  }
  const captionFrame = path.join(OUT_DIR, 'sample-frame-caption.png');
  const cardFrame = path.join(OUT_DIR, 'sample-frame-card-bottom.png');
  const firstCaption = subtitleOverlays.find(s => s.action === 'caption') || subtitleOverlays.find(s => s.start > INTRO_SECONDS) || subtitleOverlays[0];
  const assistantEvent = audioEvents.find(e => e.role === 'assistant' || e.voice === 'ASSISTANT') || audioEvents.at(-1);
  run(FFMPEG, ['-y', '-ss', String(firstCaption ? firstCaption.start + 0.4 : duration * 0.35), '-i', demoMp4, '-frames:v', '1', captionFrame]);
  run(FFMPEG, ['-y', '-ss', String(assistantEvent ? INTRO_SECONDS + assistantEvent.at + 8.5 : duration * 0.5), '-i', demoMp4, '-frames:v', '1', cardFrame]);
  frames.push(rel(captionFrame), rel(cardFrame));
  const introItem = timeline.find(t => /unofficial Alexa plus experience simulator/i.test(t.text)) || timeline[0];
  const firstOwnerAsk = timeline.find(t => t.role === 'OWNER' || t.role === 'owner');
  const hoodItem = timeline.find(t => /^Under the hood:/i.test(t.text));
  const requestedFrames = [];
  for (const [name, item] of [['intro-midpoint', introItem], ['owner-ask-midpoint', firstOwnerAsk], ['hood-midpoint', hoodItem]]) {
    if (!item) continue;
    const png = path.join(OUT_DIR, `sample-frame-${name}.png`);
    run(FFMPEG, ['-y', '-ss', String((item.start + item.end) / 2), '-i', demoMp4, '-frames:v', '1', png]);
    frames.push(rel(png));
    requestedFrames.push(rel(png));
  }

  const pixelChecks = [];
  for (const frame of frames) {
    pixelChecks.push(checkNoGreyBand(frame, ['-i', path.join(ROOT, frame)], contentHeight));
  }
  for (const at of [duration * 0.25, duration * 0.5, duration * 0.75]) {
    pixelChecks.push(checkNoGreyBand(`out/demo.mp4@${at.toFixed(2)}s`, ['-ss', String(at), '-i', demoMp4], contentHeight));
  }

  const temporalChecks = {
    originalAudioNoOverlap: originalAudioOverlapChecks,
    audioNoOverlap: audioOverlapChecks,
    captionsNoOverlap: captionOverlapChecks,
    captionsWithinClips: captionClipChecks,
    toleranceSeconds: 0.05
  };
  const stepLatencies = [];
  const manifestAudio = manifest.events.filter(e => (e.action === 'say' || e.action === 'dynamicSpeak') && (e.clipPath || e.file));
  for (let i = 0; i < manifestAudio.length; i++) {
    const event = manifestAudio[i];
    if (event.action !== 'dynamicSpeak') continue;
    for (let j = i - 1; j >= 0; j--) {
      const prev = manifestAudio[j];
      if (prev.action === 'say' && prev.voice === 'OWNER') {
        const ownerEndMs = Math.round((prev.at * 1000) + (prev.durationMs || 0));
        stepLatencies.push({
          ownerText: firstChars(prev.text, 80),
          dynamicRole: event.role,
          dynamicText: firstChars(event.text, 80),
          ownerClipEndMs: ownerEndMs,
          firstDynamicSpeakStartMs: event.startMs,
          latencyMs: Math.round(event.startMs - ownerEndMs)
        });
        break;
      }
    }
  }
  const compressionReport = compressionSegments
    .filter(s => s.spedUp)
    .map(s => ({
      originalStart: Number(s.originalStart.toFixed(3)),
      originalEnd: Number(s.originalEnd.toFixed(3)),
      compressedStart: Number(s.compressedStart.toFixed(3)),
      compressedEnd: Number(s.compressedEnd.toFixed(3)),
      originalDuration: Number(s.originalDuration.toFixed(3)),
      compressedDuration: Number(s.compressedDuration.toFixed(3)),
      factor: Number(s.factor.toFixed(3))
    }));
  const composeReport = { demo: rel(demoMp4), durationSeconds: duration, ffprobe: JSON.parse(probe), loudness, pixelChecks, temporalChecks, timeline: timelineTable, stepLatencies, compressionSegments: compressionReport, speedBadges: badgeOverlays, requestedFrames, subtitles: rel(srtPath), subtitleBandHeight: bandHeight, contentHeight, subtitleOverlays, gif: rel(gif), gifBytes, sampleFrames: frames, introSeconds: INTRO_SECONDS, outroSeconds: OUTRO_SECONDS, maxSilenceMs: maxSilenceSeconds * 1000 };
  fs.writeFileSync(path.join(OUT_DIR, 'compose-report.json'), JSON.stringify(composeReport, null, 2));
  console.log(`Wrote ${rel(demoMp4)} (${duration.toFixed(2)}s)`);
  console.log(`GIF ${rel(gif)} ${(gifBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Frames: ${frames.join(', ')}`);
  console.log(`Pixel checks: ${JSON.stringify(pixelChecks)}`);
  console.log('Timeline:');
  for (const row of timelineTable) console.log(`${row.start.toFixed(3)}-${row.end.toFixed(3)} ${String(row.role).padEnd(9)} ${row.text}`);
  console.log('Compression segments:');
  for (const row of compressionReport) console.log(`${row.originalStart.toFixed(3)}-${row.originalEnd.toFixed(3)} -> ${row.compressedStart.toFixed(3)}-${row.compressedEnd.toFixed(3)} ${row.factor.toFixed(3)}x`);
  console.log(`Temporal checks: ${JSON.stringify(temporalChecks)}`);
  console.log(`Loudness: ${JSON.stringify(loudness)}`);
  console.log(probe);
}

main().catch(err => { console.error(err); process.exit(1); });
