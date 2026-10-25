// End-to-end through the real UI (Chrome via playwright-core) with the SCRIPTED agent. These tests prove the board,
// the safety gate and the Bryntum engine; they are NOT evidence about the LLM agent (see test/live/).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ScriptedAgent } from '../../src/agent/scripted.ts';
import { apiState, engineDates, ganttGeometry, launch, openBoard, readability, shot, startApp, stmInfo, trialWatermark, waitFor, waitReport, writeEvidence, type Browser } from './harness.ts';

let browser: Browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

const scripted = { agent: (h: any) => new ScriptedAgent(h) };
const BASE_PLAN = {
  'acme-t2': { start: '2026-10-25', end: '2026-10-25' }, 'acme-build': { start: '2026-10-25', end: '2026-11-15' },
  'acme-t3': { start: '2026-11-22', end: '2026-11-22' }, 'acme-launch': { start: '2026-11-22', end: '2026-11-27' },
};
const SHIFTED = {
  'acme-t2': { start: '2026-11-10', end: '2026-11-10' }, 'acme-build': { start: '2026-11-10', end: '2026-12-01' },
  'acme-t3': { start: '2026-12-01', end: '2026-12-01' }, 'acme-launch': { start: '2026-12-01', end: '2026-12-06' },
};
const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const ACME = Object.keys(BASE_PLAN);

test('plan loads: engine dates = server scheduler; headers, task names and dates fully readable at 1920x940; trial watermark visible', async () => {
  const { app, base } = await startApp(scripted);
  try {
    const { page, context, errors } = await openBoard(browser, base);
    const engine = await engineDates(page);
    const s = await apiState(base);
    assert.deepEqual(engine, s.schedule);
    assert.deepEqual(pick(engine, ACME), BASE_PLAN);
    const read = await readability(page);
    assert.deepEqual(read.problems, []);
    assert.ok(read.counts['header-row-0'] >= 4 && read.counts['header-row-1'] >= 12, JSON.stringify(read.counts));
    assert.equal(read.counts['task-names'], 14);
    assert.equal(read.counts['capacity-labels'], 8); // 7 phases; Rollout is booked for Ravi and Dana
    const wm = await trialWatermark(page);
    assert.deepEqual(wm, ['#gantt: Trial Version watermark present', '#capacity: Trial Version watermark present']);
    assert.deepEqual(s.audit.filter((e: any) => e.action === 'engine.verified').map((e: any) => [e.details.reason, e.details.matched, e.details.checked]), [['load', 12, 12]]);
    assert.deepEqual(errors, []);
    const geo = await ganttGeometry(page);
    assert.deepEqual(geo.ghosts, []);
    for (const id of ACME) assert.equal(geo.bars[id].height, 18, `${id} bar height`); // rowHeight 32 - 2 x barMargin 7
    assert.ok(geo.today && geo.today.line_z < geo.today.foreground_z, `Today line must paint below bars/labels: ${JSON.stringify(geo.today)}`);
    assert.deepEqual(geo.today.badge_on_bars, []);
    const path = await shot(page, '01-plan');
    writeEvidence('01-plan', { engine, readability: read, watermark: wm, bar_heights: Object.fromEntries(ACME.map((id) => [id, geo.bars[id].height])), today_line: geo.today, screenshot: path });
    await context.close();
  } finally { await app.close(); }
});

test('agent preview → owner applies in the UI → Bryntum engine moves the chain (STM transaction) → undo via STM', async () => {
  const { app, base } = await startApp(scripted);
  try {
    const { page, context, errors } = await openBoard(browser, base);
    await page.click('[data-prompt]');
    const card = await waitFor(async () => (await apiState(base)).confirmations.find((c: any) => c.kind === 'apply_schedule' && c.status === 'pending'), 20_000, 'apply card');
    await page.waitForSelector(`[data-confirmation="${card.id}"] button[data-action=approve]`);
    // Ghost preview: the Gantt's baselines feature is on and shows exactly the tasks the preview moves.
    await page.waitForFunction(() => !(window as any).__tranche.gantt.features.baselines.disabled);
    const ghost = await page.evaluate(() => [...document.querySelectorAll('#gantt .b-task-baseline.ghost-preview')].length);
    assert.equal(ghost, 4);
    // Preview must not squeeze the real bars (Bryntum's default baseline layout shrinks them to ~7px) and milestone
    // ghosts must be full-size dashed diamonds with their own label that overlaps no other visible label.
    await page.waitForTimeout(400);
    const geo = await ganttGeometry(page);
    for (const id of ACME) assert.equal(geo.bars[id].height, 18, `${id} bar height during preview`);
    assert.deepEqual(geo.ghosts.map((g) => g.task_id), ['acme-t2', 'acme-build', 'acme-t3', 'acme-launch']);
    const ghostMilestones = geo.ghosts.filter((g) => g.milestone);
    assert.deepEqual(ghostMilestones.map((g) => g.label).sort(), ['INV-2 → 10 Nov', 'INV-3 → 1 Dec']);
    for (const g of ghostMilestones) {
      assert.deepEqual(g.diamond, { width: '16px', height: '16px', border: 'dashed' });
      assert.deepEqual(g.label_overlaps, [], `${g.label} overlaps`);
    }
    for (const g of geo.ghosts.filter((x) => !x.milestone)) assert.ok(g.box.height >= 18 && g.box.width > 18, JSON.stringify(g));
    const visibleLabels = await page.evaluate(() => [...document.querySelectorAll('#gantt .b-sch-label')].filter((l) => getComputedStyle(l).visibility !== 'hidden' && l.getBoundingClientRect().width > 0).map((l) => (l as HTMLElement).innerText).sort());
    assert.deepEqual(visibleLabels, ['INV-1 €3,600', 'INV-4 €3,000', 'INV-5 €3,000']);
    assert.deepEqual(pick(await engineDates(page), ACME), BASE_PLAN, 'preview must not move the plan');
    assert.deepEqual(await stmInfo(page), { position: 0, queue: [], canUndo: false });
    const previewShot = await shot(page, '02-preview-INV-2');

    await page.click(`[data-confirmation="${card.id}"] button[data-action=approve]`);
    await waitReport(page, 'apply', card.id);
    const applied = await engineDates(page);
    assert.deepEqual(pick(applied, ACME), SHIFTED);
    let s = await apiState(base);
    assert.deepEqual(applied, s.schedule);
    assert.equal(s.confirmations.find((c: any) => c.id === card.id).status, 'approved');
    assert.deepEqual(await stmInfo(page), { position: 1, queue: [card.id], canUndo: true });
    const audit = s.audit.map((e: any) => [e.action, e.details.confirmation_id ?? e.details.id ?? null]);
    for (const a of [['confirmation.requested', card.id], ['schedule.applied', card.id], ['confirmation.approved', card.id], ['engine.verified', card.id]]) assert.ok(audit.some((x: any) => x[0] === a[0] && x[1] === a[1]), a.join(' '));
    // Capacity view shares the Gantt project: Dana is now double-booked and only Dana's bars are outlined.
    assert.deepEqual(s.conflicts.map((c: any) => [c.resource, c.task_a, c.task_b, c.overlap_start, c.overlap_end]), [['dana', 'acme-build', 'birch-rollout', '2026-11-16', '2026-11-23']]);
    const outlined = await page.evaluate(() => {
      const sch = (window as any).__tranche.scheduler;
      return [...document.querySelectorAll('#capacity .b-sch-event-wrap')].filter((w) => w.querySelector('.booking-conflict')).map((w) => {
        const a = sch.resolveAssignmentRecord(w);
        return `${a?.resource?.id}:${a?.event?.id}`;
      }).sort();
    });
    assert.deepEqual(outlined, ['dana:acme-build', 'dana:birch-rollout']);
    const appliedShot = await shot(page, '03-applied-INV-2');

    await page.click('#undo');
    await waitReport(page, 'undo', card.id);
    const undone = await engineDates(page);
    assert.deepEqual(pick(undone, ACME), BASE_PLAN);
    s = await apiState(base);
    assert.deepEqual(undone, s.schedule);
    assert.deepEqual(s.conflicts, []);
    assert.equal(s.plan_dates['INV-2'], '2026-10-25');
    assert.deepEqual(await stmInfo(page), { position: 0, queue: [card.id], canUndo: false });
    assert.ok(s.audit.some((e: any) => e.action === 'schedule.undone' && e.details.confirmation_id === card.id && e.details.via === 'bryntum-stm'));
    assert.ok(s.audit.some((e: any) => e.action === 'engine.verified' && e.details.reason === 'undo'));
    assert.deepEqual(errors, []);
    const undoShot = await shot(page, '04-undone');
    writeEvidence('02-apply-undo', { confirmation: card.id, preview_geometry: geo, engine_after_apply: pick(applied, ACME), engine_after_undo: pick(undone, ACME), outlined, screenshots: [previewShot, appliedShot, undoShot] });
    await context.close();
  } finally { await app.close(); }
});

test('client pays while cards are pending → both are swept to STALE (no Apply button, API refuses); release preview then pulls the plan to the PayPal payment date', async () => {
  const { app, base } = await startApp(scripted);
  try {
    const { page, context, errors } = await openBoard(browser, base);
    await page.click('[data-prompt]');
    const card = await waitFor(async () => (await apiState(base)).confirmations.find((c: any) => c.kind === 'apply_schedule' && c.status === 'pending'), 20_000, 'apply card');
    await page.waitForSelector(`[data-confirmation="${card.id}"] button[data-action=approve]`);
    await page.click('details.demo summary');
    await page.selectOption('#sim-invoice', 'INV-2');
    await page.click('[data-sim=payer_pays]');
    await waitFor(async () => (await apiState(base)).events.find((e: any) => e.event_type === 'INVOICING.INVOICE.PAID' && e.invoice_number === 'INV-2'), 10_000, 'PAID event');
    // The PAID event sweeps the pending cards to STALE before the owner can click Apply.
    let s = await waitFor(async () => { const x = await apiState(base); return x.confirmations.filter((c: any) => c.status === 'stale').length === 2 && x; }, 10_000, 'stale');
    const reminder = s.confirmations.find((c: any) => c.kind === 'send_reminder');
    assert.deepEqual(s.audit.filter((e: any) => e.action === 'confirmation.marked_stale').map((e: any) => [e.actor, e.details.id]), [['system', card.id], ['system', reminder.id]]);
    await page.waitForSelector(`[data-confirmation="${card.id}"].conf.stale`);
    assert.equal(await page.locator(`[data-confirmation="${card.id}"] button[data-action=approve]`).count(), 0, 'no Apply button on a stale card');
    assert.equal(await page.locator(`[data-confirmation="${reminder.id}"] button[data-action=approve]`).count(), 0, 'no Send button on a stale reminder');
    // A direct API approve of the stale card is still refused.
    const direct = await fetch(`${base}/api/confirmations/${card.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ payload_hash: card.payload_hash }) });
    assert.equal(direct.status, 409);
    assert.equal((await direct.json()).error.code, 'ALREADY_RESOLVED');
    assert.equal(s.mock_calls.filter((c: any) => c.op === 'remind').length, 0);
    assert.equal(s.plan_dates['INV-2'], '2026-10-25');
    assert.deepEqual(pick(await engineDates(page), ACME), BASE_PLAN, 'stale card must not move the Gantt');
    assert.deepEqual(await stmInfo(page), { position: 0, queue: [], canUndo: false });
    await shot(page, '05-stale-after-payment');

    await page.fill('#ask-input', 'INV-2 was just paid on PayPal. Update the plan?');
    await page.click('#ask-form button');
    const release = await waitFor(async () => (await apiState(base)).confirmations.find((c: any) => c.kind === 'apply_schedule' && c.status === 'pending' && c.preview_id === 'pv_release_INV-2_2026-11-03'), 20_000, 'release card');
    await page.waitForSelector(`[data-confirmation="${release.id}"] button[data-action=approve]`);
    await page.click(`[data-confirmation="${release.id}"] button[data-action=approve]`);
    await waitReport(page, 'apply', release.id);
    const engine = await engineDates(page);
    assert.deepEqual(pick(engine, ['acme-t2', 'acme-build']), { 'acme-t2': { start: '2026-11-03', end: '2026-11-03' }, 'acme-build': { start: '2026-11-03', end: '2026-11-24' } });
    s = await apiState(base);
    assert.deepEqual(engine, s.schedule);
    assert.equal(s.invoices.find((i: any) => i.invoice_number === 'INV-2').status, 'PAID');
    assert.deepEqual(s.blocked, []);
    assert.deepEqual(errors, []);
    const path = await shot(page, '06-release-after-payment');
    writeEvidence('03-stale-and-release', { stale_card: card.id, release_card: release.id, engine: pick(engine, ['acme-t2', 'acme-build', 'acme-t3', 'acme-launch']), screenshot: path });
    await context.close();
  } finally { await app.close(); }
});

test('PayPal refund event wakes the agent (auto-watch); owner approves the reminder for INV-2 → mock PayPal remind is called once', async () => {
  const { app, base } = await startApp({ ...scripted, autoWatch: true });
  try {
    const { page, context, errors } = await openBoard(browser, base);
    await page.click('details.demo summary');
    await page.selectOption('#sim-invoice', 'INV-4');
    await page.click('[data-sim=refund]');
    const card = await waitFor(async () => (await apiState(base)).confirmations.find((c: any) => c.kind === 'apply_schedule' && c.invoice_number === 'INV-4' && c.status === 'pending'), 20_000, 'INV-4 card');
    let s = await apiState(base);
    assert.equal(s.transcript.filter((m: any) => m.role === 'owner').length, 0, 'no owner prompt was needed');
    assert.ok(s.audit.some((e: any) => e.action === 'agent.turn' && e.details.trigger === 'paypal-event'));
    await page.waitForSelector(`[data-confirmation="${card.id}"] button[data-action=approve]`);
    await page.click(`[data-confirmation="${card.id}"] button[data-action=approve]`);
    await waitReport(page, 'apply', card.id);
    const engine = await engineDates(page);
    assert.deepEqual(pick(engine, ['birch-t1', 'birch-identity']), { 'birch-t1': { start: '2026-11-10', end: '2026-11-10' }, 'birch-identity': { start: '2026-11-10', end: '2026-11-24' } });
    s = await apiState(base);
    assert.deepEqual(engine, s.schedule);
    await shot(page, '07-refund-INV-4-applied');

    await page.click('[data-prompt]');
    const rem = await waitFor(async () => (await apiState(base)).confirmations.find((c: any) => c.kind === 'send_reminder' && c.invoice_number === 'INV-2' && c.status === 'pending'), 20_000, 'reminder card');
    await page.waitForSelector(`[data-confirmation="${rem.id}"] button[data-action=approve]`);
    await page.click(`[data-confirmation="${rem.id}"] button[data-action=approve]`);
    s = await waitFor(async () => { const x = await apiState(base); return x.confirmations.find((c: any) => c.id === rem.id).status === 'approved' && x; }, 10_000, 'reminder approved');
    assert.deepEqual(s.mock_calls.filter((c: any) => c.op === 'remind').map((c: any) => [c.invoice_id, c.at]), [['INV2-ACME-0002', '2026-11-03']]);
    const remAudit = s.audit.find((e: any) => e.action === 'paypal.invoice.remind');
    assert.equal(remAudit.details.mode, 'mock');
    assert.equal(remAudit.details.reminders_today, 1);
    assert.deepEqual(errors, []);
    const path = await shot(page, '08-reminder-sent');
    writeEvidence('04-refund-and-reminder', { refund_card: card.id, reminder_card: rem.id, engine: pick(engine, ['birch-t1', 'birch-identity', 'birch-t2', 'birch-rollout']), reminder_audit: remAudit, screenshot: path });
    await context.close();
  } finally { await app.close(); }
});

for (const tz of ['Europe/Dublin', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Auckland']) {
  test(`time zone ${tz}: engine dates equal the server scheduler before and after an approved shift (DST-safe noon anchor)`, async () => {
    const { app, base } = await startApp(scripted);
    try {
      const { page, context, errors } = await openBoard(browser, base, { timezoneId: tz });
      const resolved = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
      assert.ok(resolved === tz || (tz === 'Asia/Kolkata' && resolved === 'Asia/Calcutta'), `browser time zone ${resolved}`);
      assert.deepEqual(await engineDates(page), (await apiState(base)).schedule);
      await app.askAgent('INV-2 is overdue', 'owner').done;
      const card = (await apiState(base)).confirmations.find((c: any) => c.kind === 'apply_schedule');
      await app.broker.approve(card.id, card.payload_hash);
      await waitReport(page, 'apply', card.id);
      const engine = await engineDates(page);
      assert.deepEqual(engine, (await apiState(base)).schedule);
      assert.deepEqual(pick(engine, ACME), SHIFTED);
      assert.deepEqual(errors, []);
      writeEvidence(`05-tz-${tz.replace('/', '-')}`, { tz, engine: pick(engine, ACME) });
      await context.close();
    } finally { await app.close(); }
  });
}
