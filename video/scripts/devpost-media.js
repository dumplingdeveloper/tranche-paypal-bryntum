// Tranche (new code, MIT): builds the Devpost gallery (3:2, 1920x1280) and the YouTube thumbnail (1280x720)
// from real UI stills written by record.js `snapshot` steps (video/out/stills/*.png). Pixels of the UI are not
// edited; the still is placed unscaled between two caption bands (gallery) or scaled below a title band (thumbnail; the bottom of the still is cut off by the frame).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const VIDEO_DIR = path.resolve(here, '..');
const STILLS = path.join(VIDEO_DIR, 'out', 'stills');
const OUT = path.resolve(VIDEO_DIR, '..', 'artifacts', 'devpost');

const GALLERY = [
  { still: '01-overdue-blocks-phase', title: 'An overdue PayPal tranche blocks the next phase',
    detail: 'Bryntum Gantt: each phase depends on a PayPal invoice milestone. INV-2 is 9 days overdue, so Build is blocked (red).' },
  { still: '02-agent-preview-and-approvals', title: 'The agent proposes; you approve',
    detail: 'The AI agent can read the board and file requests, but cannot change anything. Our scheduler code, not the model, computes the dashed preview dates.' },
  { still: '03-applied-in-bryntum-engine', title: 'Approved changes are applied in the Bryntum engine',
    detail: 'Apply runs in the Bryntum project (commitAsync), checked against the preview, recorded in the audit log, undoable via STM.' },
  { still: '04-paid-reminder-stale-release-preview', title: 'A payment event wakes the agent by itself',
    detail: 'INVOICING.INVOICE.PAID: the unsent reminder turns stale, and the agent previews releasing the plan to the real payment date.' },
  { still: '05-release-applied-audit-log', title: 'Every step lands in the audit log',
    detail: 'Release applied after approval. The audit log shows the preview, the approval, and the engine check of every date.' }
];
const THUMB = { still: '02-agent-preview-and-approvals', title: 'Tranche', line: 'Late PayPal payment? The schedule knows.' };
// MEDIA_PAYPAL=sandbox when the stills were recorded against the real PayPal sandbox (badge "PayPal: REAL SANDBOX API").
const PAYPAL_NOTE = process.env.MEDIA_PAYPAL === 'sandbox'
  ? 'PayPal: real sandbox API (public default credentials)'
  : 'PayPal in mock mode';
const FOOTER = `Real UI screenshot · Tranche · ${PAYPAL_NOTE} · Bryntum Gantt & SchedulerPro (trial)`;

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dataUrl = (file) => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;

function galleryHtml(item, src) {
  return `<!doctype html><html><head><style>
  html,body{margin:0;width:1920px;height:1280px;background:#0f172a;font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;overflow:hidden}
  .top{height:200px;box-sizing:border-box;padding:34px 56px 0;color:#f8fafc}
  .top h1{margin:0 0 14px;font-size:54px;font-weight:700;letter-spacing:-.5px}
  .top p{margin:0;font-size:29px;color:#cbd5e1;line-height:1.3}
  img{display:block;width:1920px;height:940px}
  .bottom{height:140px;box-sizing:border-box;padding:0 56px;display:flex;align-items:center;color:#94a3b8;font-size:24px}
  </style></head><body>
  <div class="top"><h1>${esc(item.title)}</h1><p>${esc(item.detail)}</p></div>
  <img src="${src}">
  <div class="bottom">${esc(FOOTER)}</div></body></html>`;
}

function thumbHtml(src) {
  return `<!doctype html><html><head><style>
  html,body{margin:0;width:1280px;height:720px;background:#0f172a;font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;overflow:hidden;position:relative}
  img{position:absolute;left:0;top:196px;width:1280px;height:627px}
  .band{position:absolute;left:0;top:0;width:1280px;height:196px;background:#0f172a;color:#f8fafc;padding:22px 48px 0;box-sizing:border-box}
  h1{margin:0;font-size:96px;font-weight:800;letter-spacing:-2px;line-height:1}
  p{margin:10px 0 0;font-size:42px;font-weight:600;color:#fde68a}
  </style></head><body><img src="${src}"><div class="band"><h1>${esc(THUMB.title)}</h1><p>${esc(THUMB.line)}</p></div></body></html>`;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const results = [];
  try {
    const shoot = async (html, width, height, name) => {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      await page.setContent(html, { waitUntil: 'load' });
      const file = path.join(OUT, name);
      await page.screenshot({ path: file, type: 'png' });
      await page.close();
      const buf = fs.readFileSync(file);
      results.push({ file: path.relative(path.resolve(VIDEO_DIR, '..'), file), width, height, bytes: buf.length,
        md5: crypto.createHash('md5').update(buf).digest('hex') });
    };
    for (const [i, item] of GALLERY.entries()) {
      const src = path.join(STILLS, `${item.still}.png`);
      if (!fs.existsSync(src)) throw new Error(`missing still ${src}; run the recorder with snapshot steps first`);
      await shoot(galleryHtml(item, dataUrl(src)), 1920, 1280, `gallery-${i + 1}-${item.still}.png`);
    }
    await shoot(thumbHtml(dataUrl(path.join(STILLS, `${THUMB.still}.png`))), 1280, 720, 'youtube-thumbnail-1280x720.png');
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(OUT, 'media-report.json'), `${JSON.stringify({ source: 'video/out/stills (record.js snapshot steps)', images: results }, null, 2)}\n`);
  for (const r of results) console.log(`${r.file} ${r.width}x${r.height} ${r.bytes} bytes md5 ${r.md5}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
