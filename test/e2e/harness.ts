// Shared helpers for the Playwright end-to-end tests. Every screenshot / evidence file under artifacts/ is written
// by these tests at run time; nothing in there is hand-made.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { createTranche, type TrancheOptions } from '../../src/server/app.ts';
import { ROOT } from '../../src/server/static.ts';

const require = createRequire(import.meta.url);
export const { chromium } = require('playwright-core') as typeof import('playwright-core');
export type Browser = import('playwright-core').Browser;
export type Page = import('playwright-core').Page;

export const SHOTS = resolve(ROOT, process.env.TRANCHE_SHOT_DIR || 'artifacts/screenshots/e2e');
export const EVIDENCE = resolve(ROOT, process.env.TRANCHE_EVIDENCE_DIR || 'artifacts/e2e');
const FORBIDDEN = new Set([3337, 3338, 4178, 4179, 4189, 4191, 8097, 8098]);

function free(port: number) {
  return new Promise<boolean>((r) => { const s = createServer(); s.once('error', () => r(false)); s.listen(port, '127.0.0.1', () => s.close(() => r(true))); });
}
export async function freePort(from = 4317) {
  for (let p = from; p < from + 30; p++) if (!FORBIDDEN.has(p) && (await free(p))) return p;
  throw new Error('no free port near 4317');
}

export async function startApp(opts: TrancheOptions) {
  const app = await createTranche(opts);
  const port = await app.listen(await freePort());
  return { app, base: `http://127.0.0.1:${port}` };
}

export async function launch() {
  return chromium.launch({ channel: 'chrome', headless: process.env.HEADED !== '1' });
}

export async function openBoard(browser: Browser, base: string, opts: { timezoneId?: string } = {}) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 940 }, timezoneId: opts.timezoneId });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  await page.goto(`${base}/`);
  await page.waitForFunction(() => (window as any).__tranche?.ready === true, null, { timeout: 30_000 });
  await waitReport(page, 'load');
  return { page, context, errors };
}

export function waitReport(page: Page, reason: string, confirmationId?: string, timeout = 20_000) {
  return page.waitForFunction(([r, c]) => (window as any).__tranche.reports.some((x: any) => x.reason === r && (!c || x.confirmation_id === c)), [reason, confirmationId] as const, { timeout });
}

// Reads the Bryntum engine's own task dates straight from the Gantt taskStore after commitAsync (calendar day in the
// browser's time zone), independent of the app's own reporting helper.
export function engineDates(page: Page): Promise<Record<string, { start: string; end: string }>> {
  return page.evaluate(async () => {
    const g = (window as any).__tranche.gantt;
    await g.project.commitAsync();
    const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const out: Record<string, { start: string; end: string }> = {};
    g.taskStore.forEach((t: any) => { if (t.kind !== 'project') out[t.id] = { start: day(t.startDate), end: day(t.endDate) }; });
    return out;
  });
}

export const stmInfo = (page: Page) => page.evaluate(() => { const s = (window as any).__tranche.stm; return { position: s.position as number, queue: [...s.queue] as string[], canUndo: s.canUndo as boolean }; });

export async function apiState(base: string) {
  return (await (await fetch(`${base}/api/state`)).json()) as any;
}

export async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, timeout = 20_000, label = 'condition'): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400); // let Bryntum finish its render animation frame
  const path = resolve(SHOTS, `${name}.png`);
  await page.screenshot({ path });
  return path;
}

export function writeEvidence(name: string, data: unknown) {
  mkdirSync(EVIDENCE, { recursive: true });
  const path = resolve(EVIDENCE, `${name}.json`);
  writeFileSync(path, JSON.stringify({ written_by: 'test', at: new Date().toISOString(), ...(data as object) }, null, 2));
  return path;
}

// Geometry check: every text label inside the given elements is fully inside its own box (not clipped / ellipsised)
// and no two labels in the same header row overlap.
export function readability(page: Page) {
  return page.evaluate(() => {
    const textRect = (el: Element) => {
      const r = document.createRange(); r.selectNodeContents(el);
      return r.getBoundingClientRect();
    };
    const problems: string[] = [];
    const inside = (el: Element, label: string, box: DOMRect) => {
      const t = textRect(el);
      if (!t.width) return;
      if (t.left < box.left - 0.5 || t.right > box.right + 0.5) problems.push(`${label} clipped: "${(el as HTMLElement).innerText}" text ${t.left.toFixed(1)}-${t.right.toFixed(1)} box ${box.left.toFixed(1)}-${box.right.toFixed(1)}`);
      const h = el as HTMLElement;
      if (h.scrollWidth > h.clientWidth + 1 && getComputedStyle(h).overflow !== 'visible') problems.push(`${label} overflow: "${h.innerText}" ${h.scrollWidth}>${h.clientWidth}`);
    };
    const counts: Record<string, number> = {};
    for (const host of ['#gantt']) {
      const root = document.querySelector(host)!;
      root.querySelectorAll('.b-sch-header-row').forEach((row, ri) => {
        const rects: Array<{ l: number; r: number; t: string }> = [];
        const vis = (row as HTMLElement).getBoundingClientRect();
        row.querySelectorAll('.b-sch-header-time-axis-cell').forEach((cell) => {
          const text = cell.querySelector('.b-sch-header-text');
          if (!text) return;
          const t = textRect(text);
          if (t.right <= vis.left || t.left >= vis.right) return; // scrolled out of view
          counts[`header-row-${ri}`] = (counts[`header-row-${ri}`] || 0) + 1;
          inside(text, `header row ${ri}`, cell.getBoundingClientRect());
          if (t.left < vis.left - 0.5 || t.right > vis.right + 0.5) problems.push(`header row ${ri} label "${(text as HTMLElement).innerText}" cut by the view edge`);
          rects.push({ l: t.left, r: t.right, t: (text as HTMLElement).innerText });
        });
        rects.sort((a, b) => a.l - b.l);
        for (let i = 1; i < rects.length; i++) if (rects[i].l < rects[i - 1].r) problems.push(`header row ${ri} overlap: "${rects[i - 1].t}" / "${rects[i].t}"`);
      });
      root.querySelectorAll('.b-grid-header .b-grid-header-text-content').forEach((h) => { counts['column-headers'] = (counts['column-headers'] || 0) + 1; inside(h, 'column header', h.getBoundingClientRect()); });
      root.querySelectorAll('.b-grid-row').forEach((row) => {
        const name = row.querySelector('.b-name-cell .b-tree-cell-value') || row.querySelector('.b-name-cell .b-tree-cell-inner');
        if (name) { counts['task-names'] = (counts['task-names'] || 0) + 1; inside(name, 'task name', (name.closest('.b-grid-cell') as Element).getBoundingClientRect()); }
        row.querySelectorAll('.b-date-cell').forEach((c) => { counts['date-cells'] = (counts['date-cells'] || 0) + 1; inside(c, 'date cell', c.getBoundingClientRect()); });
        row.querySelectorAll('.state-chip').forEach((c) => { counts['tranche-chips'] = (counts['tranche-chips'] || 0) + 1; inside(c, 'tranche chip', (c.closest('.b-grid-cell') as Element).getBoundingClientRect()); });
      });
    }
    document.querySelectorAll('#capacity .b-sch-event-wrap:not(.b-released) .b-sch-event-content').forEach((c) => {
      counts['capacity-labels'] = (counts['capacity-labels'] || 0) + 1;
      inside(c, 'capacity label', (c.closest('.b-sch-event') as Element).getBoundingClientRect());
    });
    return { problems, counts };
  });
}

// The Bryntum trial watermark is an SVG background on the grids. We never hide it; this proves it is rendered.
export function trialWatermark(page: Page) {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const host of ['#gantt', '#capacity']) {
      const el = document.querySelector(`${host} .b-time-axis-sub-grid`);
      const bg = el ? getComputedStyle(el).backgroundImage : '';
      const m = /base64,([^")]+)/.exec(bg);
      const svg = m ? atob(m[1]) : '';
      out.push(`${host}: ${/Trial Version/i.test(svg) ? 'Trial Version watermark present' : svg ? 'svg without trial text' : 'none'}`);
    }
    return out;
  });
}
