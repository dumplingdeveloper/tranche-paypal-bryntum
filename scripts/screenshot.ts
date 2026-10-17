// Headless Chrome screenshots of the spike Gantt. Usage: node scripts/screenshot.ts
// PLAYWRIGHT_CORE (optional) = path to a playwright-core package; Chrome is used via channel 'chrome'.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { startDevServer } from '../src/server/dev.ts';

const require = createRequire(import.meta.url);
const pwPath = process.env.PLAYWRIGHT_CORE || '/Users/shiyx/Downloads/claude_folder/hackathon_amazon/video/node_modules/playwright-core';
const { chromium } = require(pwPath);

const port = Number(process.env.PORT || 4317);
const server = await startDevServer(port);
const base = `http://127.0.0.1:${port}`;
const shots = [
  { name: 'gantt-plan', url: `${base}/` },
  { name: 'gantt-preview-INV-2', url: `${base}/?preview=INV-2&assumed=2026-11-10` },
];
await mkdir('artifacts/screenshots', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const report: Record<string, unknown> = {};
try {
  for (const shot of shots) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 900 }, timezoneId: 'UTC', locale: 'en-IE' });
    const page = await context.newPage();
    const external = new Set<string>();
    const consoleErrors: string[] = [];
    page.on('request', (r: { url(): string }) => { const u = new URL(r.url()); if (u.hostname !== '127.0.0.1') external.add(`${u.protocol}//${u.hostname}${u.pathname}`); });
    page.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
    page.on('pageerror', (e: Error) => consoleErrors.push(`pageerror: ${e.message}`));
    await page.goto(shot.url, { waitUntil: 'load' });
    await page.waitForFunction(() => (window as unknown as { __tranche?: { ready?: boolean } }).__tranche?.ready === true, null, { timeout: 60_000 });
    await page.waitForTimeout(800);
    const state = await page.evaluate(() => (window as unknown as { __tranche: unknown }).__tranche);
    const watermark = await page.evaluate(() => {
      const hits = [...document.querySelectorAll('body *')].filter((el) => /trial|watermark|bryntum/i.test((el as HTMLElement).className?.toString() || '') || /trial/i.test((el as HTMLElement).innerText || '') && el.children.length === 0);
      return hits.slice(0, 8).map((el) => ({ tag: el.tagName, cls: String((el as HTMLElement).className).slice(0, 120), text: ((el as HTMLElement).innerText || '').slice(0, 120) }));
    });
    const file = `artifacts/screenshots/${shot.name}.png`;
    await page.screenshot({ path: file });
    report[shot.name] = { url: shot.url, file, state, externalRequests: [...external], consoleErrors, watermarkCandidates: watermark };
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
await writeFile('artifacts/logs/screenshot-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
