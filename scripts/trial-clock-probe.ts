// Probes Bryntum trial expiry behaviour by faking the browser clock (Playwright clock API). Usage: node scripts/trial-clock-probe.ts
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { createTranche } from '../src/server/app.ts';
import { ScriptedAgent } from '../src/agent/scripted.ts';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const port = Number(process.env.PORT || 4318);
const server = await createTranche({ agent: (h) => new ScriptedAgent(h) });
await server.listen(port);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const dates = (process.env.PROBE_DATES || '2026-10-17,2026-11-09,2026-11-30,2026-12-31,2027-03-01').split(',');
const out: Record<string, unknown> = {};
try {
  for (const d of dates) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 700 }, timezoneId: 'UTC' });
    const page = await context.newPage();
    await page.clock.install({ time: new Date(`${d}T10:00:00Z`) });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    let ready = true;
    try { await page.waitForFunction(() => (window as unknown as { __tranche?: { ready?: boolean } }).__tranche?.ready === true, null, { timeout: 30_000 }); } catch { ready = false; }
    await page.clock.runFor(2000).catch(() => {});
    const info = await page.evaluate(() => ({
      state: (window as unknown as { __tranche?: unknown }).__tranche,
      taskBars: document.querySelectorAll('.b-gantt-task').length,
      popups: [...document.querySelectorAll('.b-popup, .b-messagedialog, .b-toast, .b-mask')].map((el) => (el as HTMLElement).innerText.slice(0, 200)),
      trialText: [...document.querySelectorAll('body *')].filter((el) => el.children.length === 0 && /trial|expired/i.test((el as HTMLElement).innerText || '')).map((el) => (el as HTMLElement).innerText.slice(0, 200)).slice(0, 5),
    }));
    await page.screenshot({ path: `artifacts/tmp/trial-probe-${d}.png` });
    out[d] = { ready, ...info };
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}
await writeFile('artifacts/logs/trial-clock-probe.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
