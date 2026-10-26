import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { CACHE_DIR, OUT_DIR, VOICES, clipId, clipPath, collectSayLines, ensureDirs, parseArgs, readScene, rel } from './common.js';
import { ensureClip, getTts } from './tts-engine.js';
import { patchPlaywrightVideoTiming } from './video-timing.js';

const FRAME_WIDTH = 1920;
const FRAME_HEIGHT = 1080;

function resolveUrl(baseUrl, target = '/') {
  if (/^https?:\/\//.test(target) || target.startsWith('file:')) return target;
  return new URL(target, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

async function waitForStep(page, step, timeout) {
  if (step.selector) return page.locator(step.selector).waitFor({ state: step.state || 'visible', timeout });
  if (step.text) return page.getByText(step.text, { exact: !!step.exact }).first().waitFor({ state: 'visible', timeout });
  throw new Error('waitFor step requires selector or text');
}

async function assertViewport(page, expectedWidth, expectedHeight) {
  const actual = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio
  }));
  if (actual.innerWidth !== expectedWidth || actual.innerHeight !== expectedHeight) {
    throw new Error(`Viewport mismatch: expected ${expectedWidth}x${expectedHeight}, got ${actual.innerWidth}x${actual.innerHeight} (devicePixelRatio=${actual.devicePixelRatio}). Aborting to avoid padded/letterboxed video.`);
  }
  return actual;
}

function selectorsFor(scene) {
  return {
    input: scene.selectors?.input || '#text',
    send: scene.selectors?.send || '#send',
    confirm: scene.selectors?.confirm || '.confirm:not(.hidden)',
    hood: scene.selectors?.hood || '#hoodToggle'
  };
}

function estimateSpeechSeconds(text) {
  return Math.max(1.2, String(text).trim().split(/\s+/).filter(Boolean).length / 2.7);
}

async function waitForTillwiseEvent(page, type, previousCount, timeout) {
  const handle = await page.waitForFunction(
    ({ type, previousCount }) => {
      const events = window.__tillwise?.events || [];
      const matching = events.filter(e => e.type === type);
      return matching.length > previousCount ? matching[matching.length - 1] : false;
    },
    { type, previousCount },
    { timeout }
  );
  return handle.jsonValue();
}

function assertNonEmptyFinal(event, context) {
  if (!event || event.type !== 'final') return;
  if (event.empty === true || event.data?.empty === true || !String(event.data?.text || '').trim()) {
    throw new Error(`Empty final event during ${context}; refusing to record a silently wrong demo.`);
  }
}

async function tillwiseEventCount(page, type) {
  return page.evaluate((eventType) => (window.__tillwise?.events || []).filter(e => e.type === eventType).length, type);
}

async function main() {
  ensureDirs();
  const args = parseArgs();
  if (!args.url) throw new Error('record requires --url <base-url>');
  const scene = readScene(args.scene);
  const sayLines = collectSayLines(scene);
  const dryRun = !!args['dry-run'];
  const bandHeight = Number(args['subtitle-band-height'] || scene.subtitleBandHeight || 140);
  const contentHeight = FRAME_HEIGHT - bandHeight;
  if (contentHeight < 600 || bandHeight < 80) throw new Error(`Invalid subtitle band height: ${bandHeight}`);
  let sayIndex = 0;
  const videoDir = path.join(CACHE_DIR, 'videos');
  fs.rmSync(videoDir, { recursive: true, force: true });
  fs.mkdirSync(videoDir, { recursive: true });

  const selectors = selectorsFor(scene);
  const dynamicWordsPerAsk = Number(scene.dynamicWordsPerAsk || 28);
  const clipGapMs = Number(scene.clipGapMs ?? 250);
  let estimatedSeconds = 8 + (scene.tailMs || 1000) / 1000;
  for (const step of scene.steps || []) {
    if (step.action === 'pause') estimatedSeconds += (step.ms || 1000) / 1000;
    if (step.action === 'type') estimatedSeconds += String(step.text || '').length * ((step.delayMs ?? 45) / 1000);
    if (step.action === 'say') {
      if (!VOICES[step.voice]) throw new Error(`Unknown voice role '${step.voice}' in scene`);
      estimatedSeconds += estimateSpeechSeconds(step.text || '') + clipGapMs / 1000;
    }
    if (step.action === 'ask') {
      if (!VOICES[step.voice || 'OWNER']) throw new Error(`Unknown voice role '${step.voice}' in scene`);
      estimatedSeconds += estimateSpeechSeconds(step.text || '') + dynamicWordsPerAsk / 2.7 + String(step.text || '').length * 0.035 + 2 + (clipGapMs * 2) / 1000;
    }
    if (step.action === 'confirm') {
      estimatedSeconds += estimateSpeechSeconds(step.text || 'Yes.') + dynamicWordsPerAsk / 2.7 + 4 + (clipGapMs * 2) / 1000;
    }
  }
  if (estimatedSeconds >= 170) throw new Error(`Estimated duration ${estimatedSeconds.toFixed(1)}s is not under 170s.`);

  if (!dryRun) {
    console.log('Pre-warming Kokoro before recording...');
    await getTts();
  }
  const staticClipCache = new Map();
  for (const line of sayLines) {
    if (staticClipCache.has(line.path)) continue;
    if (dryRun) {
      staticClipCache.set(line.path, {
        file: line.path,
        durationSeconds: estimateSpeechSeconds(line.text),
        voiceName: line.voiceName
      });
    } else {
      staticClipCache.set(line.path, await ensureClip(line.voice, line.text));
    }
  }

  patchPlaywrightVideoTiming();
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [`--window-size=${FRAME_WIDTH},${contentHeight}`, '--force-device-scale-factor=1']
  });
  const contextOptions = {
    viewport: { width: FRAME_WIDTH, height: contentHeight },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce'
  };
  if (!dryRun) contextOptions.recordVideo = { dir: videoDir, size: { width: FRAME_WIDTH, height: contentHeight } };
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const dynamicClipPromises = [];
  const dynamicClips = [];
  page.setDefaultTimeout(Number(args.timeout || 12000));
  const started = Date.now();
  const events = [];
  let viewportCheck = null;
  const mark = (step, extra = {}) => {
    const at = (Date.now() - started) / 1000;
    events.push({ at, action: step.action, ...extra });
    console.log(`${at.toFixed(3)}s ${step.action}${extra.label ? ` ${extra.label}` : ''}`);
    return at;
  };

  async function waitForDynamicSpeak({ role, text, afterMs = 0, timeout = 30000 }) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const clip = dynamicClips.find(c => (!role || c.role === role) && (!text || c.text === text) && c.startMs >= afterMs);
      if (clip) {
        await clip.promise;
        if (clipGapMs > 0) await new Promise(r => setTimeout(r, clipGapMs));
        return clip;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Timed out waiting for dynamic speak role=${role || '*'} text=${text || '*'}`);
  }

  async function playStaticLine(voice, text, timeout = 60000) {
    const at = mark({ action: 'say' }, { voice, text, staticForStep: true });
    let durationSeconds = estimateSpeechSeconds(text);
    let file = rel(clipPath(voice, text));
    let voiceName = VOICES[voice];
    const cached = staticClipCache.get(clipPath(voice, text));
    if (cached) {
      durationSeconds = cached.durationSeconds;
      file = rel(cached.file);
      voiceName = cached.voiceName;
    } else if (!dryRun) {
      const clip = await ensureClip(voice, text);
      durationSeconds = clip.durationSeconds;
      file = rel(clip.file);
      voiceName = clip.voiceName;
    }
    Object.assign(events[events.length - 1], {
      clipId: clipId(voice, text),
      clipPath: file,
      voiceName,
      durationMs: Math.round(durationSeconds * 1000)
    });
    await new Promise(r => setTimeout(r, Math.min(timeout, Math.round(durationSeconds * 1000) + clipGapMs)));
    return { at, durationSeconds };
  }

  await page.exposeFunction('__tillwiseSpeak', async ({ role = 'assistant', text = '' } = {}) => {
    const startedCall = Date.now();
    const startMs = startedCall - started;
    const voice = role === 'host' ? 'HOST' : 'ASSISTANT';
    const clipRecord = {
      at: startMs / 1000,
      action: 'dynamicSpeak',
      role,
      voice,
      text,
      startMs,
      status: 'generating'
    };
    events.push(clipRecord);
    const promise = (async () => {
      let durationSeconds = estimateSpeechSeconds(text);
      let file = rel(clipPath(voice, text));
      let voiceName = VOICES[voice];
      if (!dryRun) {
        const clip = await ensureClip(voice, text);
        durationSeconds = clip.durationSeconds;
        file = rel(clip.file);
        voiceName = clip.voiceName;
      }
      const durationMs = Math.round(durationSeconds * 1000);
      Object.assign(clipRecord, {
        durationMs,
        file,
        clipPath: file,
        clipId: clipId(voice, text),
        voiceName,
        generationMs: Date.now() - startedCall,
        status: 'speaking'
      });
      const remaining = Math.max(0, durationMs - (Date.now() - startedCall));
      if (remaining) await new Promise(r => setTimeout(r, remaining));
      clipRecord.status = 'resolved';
      clipRecord.resolvedMs = Date.now() - started;
      return clipRecord;
    })();
    clipRecord.promise = promise;
    dynamicClips.push(clipRecord);
    dynamicClipPromises.push(promise);
    await promise;
  });

  try {
    for (const step of scene.steps || []) {
      switch (step.action) {
        case 'goto': {
          const url = resolveUrl(args.url, step.url || '/');
          mark(step, { label: url });
          await page.goto(url, { waitUntil: step.waitUntil || 'networkidle', timeout: step.timeout || 30000 });
          viewportCheck = await assertViewport(page, FRAME_WIDTH, contentHeight);
          console.log(`viewport ${viewportCheck.innerWidth}x${viewportCheck.innerHeight} dpr=${viewportCheck.devicePixelRatio}`);
          break;
        }
        case 'type':
          mark(step, { selector: step.selector, text: step.text });
          await page.locator(step.selector).waitFor({ state: 'visible', timeout: step.timeout || 12000 });
          await page.locator(step.selector).fill('');
          await page.locator(step.selector).type(step.text || '', { delay: step.delayMs ?? 45 });
          break;
        case 'click':
          mark(step, { selector: step.selector });
          await page.locator(step.selector).click({ timeout: step.timeout || 12000 });
          break;
        case 'waitFor':
          mark(step, { selector: step.selector, text: step.text });
          await waitForStep(page, step, step.timeout || 12000);
          break;
        case 'pause':
          mark(step, { ms: step.ms });
          await new Promise(r => setTimeout(r, step.ms || 1000));
          break;
        case 'say': {
          sayIndex++;
          await playStaticLine(step.voice, step.text, step.timeout || 60000);
          break;
        }
        case 'snapshot': {
          // Tranche: a still of the real UI at this moment (used for the Devpost gallery), written by the recorder.
          const dir = path.join(OUT_DIR, dryRun ? 'stills-dry-run' : 'stills');
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, `${step.name}.png`);
          mark(step, { label: rel(file) });
          await page.screenshot({ path: file, type: 'png' });
          break;
        }
        case 'caption':
          mark(step, { text: step.text });
          break;
        case 'ask': {
          const timeout = step.timeout || 45000;
          await playStaticLine(step.voice || 'OWNER', step.text, timeout);
          const beforeFinal = await tillwiseEventCount(page, 'final');
          const beforePermission = await tillwiseEventCount(page, 'permission');
          const afterMs = Date.now() - started;
          await page.locator(selectors.input).waitFor({ state: 'visible', timeout });
          await page.locator(selectors.input).fill('');
          await page.locator(selectors.input).type(step.text || '', { delay: step.delayMs ?? 35 });
          await page.locator(selectors.send).click({ timeout });
          const result = await page.waitForFunction(
            ({ beforeFinal, beforePermission }) => {
              const events = window.__tillwise?.events || [];
              const finals = events.filter(e => e.type === 'final');
              const permissions = events.filter(e => e.type === 'permission');
              if (finals.length > beforeFinal) return { kind: 'final', event: finals[finals.length - 1] };
              if (permissions.length > beforePermission) return { kind: 'permission', event: permissions[permissions.length - 1] };
              return false;
            },
            { beforeFinal, beforePermission },
            { timeout }
          ).then(h => h.jsonValue());
          if (result.kind === 'permission') {
            await waitForDynamicSpeak({ role: 'host', text: result.event?.data?.message, afterMs, timeout });
          } else {
            assertNonEmptyFinal(result.event, `ask "${step.text}"`);
            await waitForDynamicSpeak({ role: 'assistant', text: result.event?.data?.text, afterMs, timeout });
          }
          break;
        }
        case 'confirm': {
          const timeout = step.timeout || 45000;
          await page.locator(selectors.confirm).waitFor({ state: 'visible', timeout });
          await waitForDynamicSpeak({ role: 'host', afterMs: Math.max(0, Date.now() - started - 60000), timeout });
          await playStaticLine(step.voice || 'OWNER', step.text || 'Yes.', timeout);
          const beforeFinal = await tillwiseEventCount(page, 'final');
          const afterMs = Date.now() - started;
          await page.locator(selectors.input).waitFor({ state: 'visible', timeout });
          await page.locator(selectors.input).fill('');
          await page.locator(selectors.input).type((step.typeText || step.text || 'yes').replace(/\.$/, ''), { delay: step.delayMs ?? 35 });
          await page.locator(selectors.send).click({ timeout });
          const final = await waitForTillwiseEvent(page, 'final', beforeFinal, timeout);
          assertNonEmptyFinal(final, `confirm "${step.text || 'Yes.'}"`);
          await waitForDynamicSpeak({ role: 'assistant', text: final?.data?.text, afterMs, timeout });
          break;
        }
        case 'openHood':
          mark(step, { selector: step.selector || selectors.hood });
          await page.locator(step.selector || selectors.hood).click({ timeout: step.timeout || 12000 });
          if (step.waitMs) await page.waitForTimeout(step.waitMs);
          break;
        case 'scrollTo':
        case 'reveal':
          mark(step, { selector: step.selector });
          await page.locator(step.selector).waitFor({ state: 'visible', timeout: step.timeout || 12000 });
          await page.locator(step.selector).evaluate((el, block) => el.scrollIntoView({ block, behavior: 'smooth' }), step.block || 'center');
          await page.waitForTimeout(step.waitMs || 700);
          break;
        default:
          throw new Error(`Unknown scene action: ${step.action}`);
      }
    }
    await Promise.allSettled(dynamicClipPromises);
    await new Promise(r => setTimeout(r, scene.tailMs || 1000));
  } finally {
    const video = page.video();
    let tillwiseEvents = [];
    try {
      tillwiseEvents = await page.evaluate(() => window.__tillwise?.events || []);
    } catch {
      tillwiseEvents = [];
    }
    await context.close();
    await browser.close();
    const dest = path.join(OUT_DIR, 'recording.webm');
    if (!dryRun) {
      const rawVideo = await video.path();
      fs.copyFileSync(rawVideo, dest);
    }
    const cleanEvents = events.map(({ promise, ...event }) => event);
    const manifest = { scene: rel(scene.__path), baseUrl: args.url, startedAt: new Date(started).toISOString(), video: dryRun ? null : rel(dest), dryRun, viewportCheck, frame: { width: FRAME_WIDTH, height: FRAME_HEIGHT }, content: { width: FRAME_WIDTH, height: contentHeight }, subtitleBandHeight: bandHeight, estimatedSeconds, events: cleanEvents, tillwiseEvents };
    fs.writeFileSync(path.join(OUT_DIR, 'recording-manifest.json'), JSON.stringify(manifest, null, 2));
    if (dryRun) console.log(`Dry run OK. Estimated duration ${estimatedSeconds.toFixed(1)}s; no video recorded.`);
    else console.log(`Recorded: ${rel(dest)}`);
    console.log(`Manifest: ${rel(path.join(OUT_DIR, 'recording-manifest.json'))}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
