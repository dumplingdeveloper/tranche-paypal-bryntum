// OPT-IN, REAL PayPal sandbox (api-m.sandbox.paypal.com): `npm run test:sandbox-live` (sets LIVE_PAYPAL=1).
// Not part of `npm run test:e2e`. Needs PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET or ~/.config/tillwise/paypal-sandbox.env.
// It seeds its OWN invoice set under a fresh prefix (so the saved demo set in .tranche/ is never consumed), drives the
// whole demo through the real UI with the SCRIPTED agent (this is evidence about PayPal + Bryntum + the safety gate,
// not about the LLM), then deletes/cancels what PayPal allows. Every PayPal request is appended to the call ledger
// (TRANCHE_PAYPAL_CALL_LOG) without headers or bodies.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ScriptedAgent } from '../../src/agent/scripted.ts';
import { PUBLIC_DEFAULT_APP_ID, newDemoPrefix, sandboxClientFromEnv } from '../../src/paypal/sandboxClient.ts';
import { seedSandbox } from '../../src/paypal/sandboxSeed.ts';
import { startPayPalStub } from '../unit/helpers/paypalStub.ts';
import { SandboxInvoicingClient } from '../../src/paypal/sandboxClient.ts';
import { apiState, engineDates, launch, openBoard, shot as realShot, startApp, stmInfo, trialWatermark, waitFor, waitReport, writeEvidence, type Browser } from '../e2e/harness.ts';

// LIVE_PAYPAL=stub runs the same flow against the local stub (test/unit/helpers/paypalStub.ts) to debug the test
// without spending sandbox calls; it writes no screenshots or evidence.
const STUB = process.env.LIVE_PAYPAL === 'stub';
const LIVE = process.env.LIVE_PAYPAL === '1' || STUB;
const TODAY = '2026-11-03';
const BASE_PLAN = {
  'acme-t2': { start: '2026-10-25', end: '2026-10-25' }, 'acme-build': { start: '2026-10-25', end: '2026-11-15' },
  'acme-t3': { start: '2026-11-22', end: '2026-11-22' }, 'acme-launch': { start: '2026-11-22', end: '2026-11-27' },
};
const SHIFTED = {
  'acme-t2': { start: '2026-11-10', end: '2026-11-10' }, 'acme-build': { start: '2026-11-10', end: '2026-12-01' },
  'acme-t3': { start: '2026-12-01', end: '2026-12-01' }, 'acme-launch': { start: '2026-12-01', end: '2026-12-06' },
};
const ACME = Object.keys(BASE_PLAN);
const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));

let browser: Browser;
before(async () => { if (LIVE) browser = await launch(); });
after(async () => { await browser?.close(); });

test('REAL PayPal sandbox through the UI: overdue → preview → apply → undo (UNDONE) → payment recorded in PayPal → stale reminder → release', { skip: LIVE ? false : 'set LIVE_PAYPAL=1 (npm run test:sandbox-live)' }, async () => {
  const prefix = newDemoPrefix();
  const stub = STUB ? await startPayPalStub({ clientId: 'stub-id', clientSecret: 'stub-secret', today: TODAY }) : undefined;
  const { client, lookup } = stub
    ? { client: new SandboxInvoicingClient({ credentials: { clientId: 'stub-id', clientSecret: 'stub-secret' }, baseUrl: stub.baseUrl, prefix, today: () => TODAY, log: () => {}, sleep: async () => {} }), lookup: { source: 'stub', file: '' } }
    : sandboxClientFromEnv({ prefix, today: () => TODAY });
  assert.ok(client, `NO CREDENTIALS (${lookup.file})`);
  const ENDPOINT = stub ? stub.baseUrl : 'https://api-m.sandbox.paypal.com';
  assert.equal(client.baseUrl, ENDPOINT);
  const shot = async (page: any, name: string) => (STUB ? `(stub dry run, not written: ${name})` : realShot(page, name));
  let paid = false;
  const seeded = await seedSandbox(client, { demoToday: TODAY });
  const inv2 = seeded.find((r) => r.invoice_number === 'INV-2')!;
  assert.equal(inv2.status, 'UNPAID');
  const callsAfterSeed = client.requestCount;
  // Real sandbox: poll every 30 s, like `TRANCHE_PAYPAL=sandbox npm start`; demo controls trigger one extra poll.
  const { app, base } = await startApp({ today: TODAY, invoicing: client, pollMs: 30_000, agent: (h: any) => new ScriptedAgent(h) });
  const shots: string[] = [];
  try {
    const { page, context, errors } = await openBoard(browser, base);
    let s = await apiState(base);
    assert.deepEqual([s.modes.paypal, s.modes.paypal_endpoint, s.modes.paypal_prefix, s.modes.paypal_poll_s], ['sandbox', ENDPOINT, prefix, 30]);
    assert.equal(s.modes.paypal_app_id, client.appId);
    assert.equal(s.modes.paypal_public_credentials, client.appId === PUBLIC_DEFAULT_APP_ID);
    const pill = await page.$eval('#paypal-mode', (e) => ({ text: (e as HTMLElement).innerText, title: (e as HTMLElement).title }));
    assert.equal(pill.text, stub ? 'PayPal: SANDBOX API · local stub' : 'PayPal: REAL SANDBOX API');
    assert.ok(pill.title.includes(String(client.appId)) && pill.title.includes(prefix), pill.title);
    const i2 = s.invoices.find((i: any) => i.invoice_number === 'INV-2');
    assert.deepEqual([i2.invoice_id, i2.status, i2.days_overdue], [inv2.id, 'UNPAID', 9]);
    const engine0 = await engineDates(page);
    assert.deepEqual(engine0, s.schedule);
    assert.deepEqual(pick(engine0, ACME), BASE_PLAN);
    assert.deepEqual(await trialWatermark(page), ['#gantt: Trial Version watermark present', '#capacity: Trial Version watermark present']);
    shots.push(await shot(page, 'S1-real-sandbox-overdue'));

    // Agent (scripted) proposes; nothing moves until the owner approves.
    await page.click('[data-prompt]');
    const card = await waitFor(async () => (await apiState(base)).confirmations.find((c: any) => c.kind === 'apply_schedule' && c.status === 'pending'), 20_000, 'apply card');
    const reminder = await waitFor(async () => (await apiState(base)).confirmations.find((c: any) => c.kind === 'send_reminder' && c.status === 'pending'), 20_000, 'reminder card');
    await page.waitForSelector(`[data-confirmation="${card.id}"] button[data-action=approve]`);
    await page.waitForFunction(() => !(window as any).__tranche.gantt.features.baselines.disabled);
    await page.waitForTimeout(400);
    assert.deepEqual(pick(await engineDates(page), ACME), BASE_PLAN, 'preview must not move the plan');
    shots.push(await shot(page, 'S2-real-sandbox-preview'));

    await page.click(`[data-confirmation="${card.id}"] button[data-action=approve]`);
    await waitReport(page, 'apply', card.id);
    const applied = await engineDates(page);
    assert.deepEqual(pick(applied, ACME), SHIFTED);
    assert.deepEqual(applied, (await apiState(base)).schedule);
    assert.deepEqual(await stmInfo(page), { position: 1, queue: [card.id], canUndo: true });
    shots.push(await shot(page, 'S3-real-sandbox-applied'));

    await page.click('#undo');
    await waitReport(page, 'undo', card.id);
    s = await apiState(base);
    assert.deepEqual(pick(await engineDates(page), ACME), BASE_PLAN);
    assert.equal(s.confirmations.find((c: any) => c.id === card.id).status, 'undone');
    assert.ok(s.audit.some((e: any) => e.action === 'schedule.undone' && e.details.confirmation_id === card.id && e.details.via === 'bryntum-stm'));
    assert.equal(s.confirmations.find((c: any) => c.id === reminder.id).status, 'pending');
    shots.push(await shot(page, 'S4-real-sandbox-undone'));

    // The payment is RECORDED through the Invoicing API (a PayPal-button payment needs a sandbox buyer in a browser).
    await page.click('details.demo > summary');
    assert.equal(await page.$eval('#sim-note', (e) => (e as HTMLElement).hidden), false);
    assert.equal(await page.$eval('button[data-sim="payer_pays"]', (b) => (b as HTMLButtonElement).disabled), true);
    await page.selectOption('#sim-invoice', 'INV-2');
    const beforePay = client.requestCount;
    await page.click('button[data-sim="record_external_payment"]');
    paid = true;
    s = await waitFor(async () => { const x = await apiState(base); return x.confirmations.find((c: any) => c.id === reminder.id).status === 'stale' && x; }, 60_000, 'reminder swept to STALE by the PayPal PAID event');
    assert.ok(s.events.some((e: any) => e.invoice_number === 'INV-2' && e.event_type === 'INVOICING.INVOICE.PAID' && e.source === 'sandbox-poll'));
    assert.ok(s.audit.some((e: any) => e.action === 'confirmation.marked_stale' && e.details.id === reminder.id));
    assert.ok(s.audit.some((e: any) => e.action === 'sandbox.demo_control' && e.details.action === 'record_external_payment'));
    assert.equal(s.paypal_calls.filter((c: any) => c.op === 'remind').length, 0, 'stale reminder was never sent');
    // Read the invoice back from PayPal itself, outside the app.
    const fromPayPal = await client.getInvoice(inv2.id);
    const payment = (fromPayPal as any).payments?.transactions?.[0];
    assert.equal(fromPayPal.status, 'MARKED_AS_PAID');
    assert.deepEqual([payment?.type, payment?.method, payment?.payment_date], ['EXTERNAL', 'BANK_TRANSFER', TODAY]);
    await page.waitForSelector(`[data-confirmation="${reminder.id}"].conf.stale`);
    assert.equal(await page.locator(`[data-confirmation="${reminder.id}"] button[data-action=approve]`).count(), 0);
    shots.push(await shot(page, 'S5-real-sandbox-paid-stale-reminder'));
    const paymentCalls = client.requestCount - beforePay;

    await page.fill('#ask-input', 'INV-2 was just paid on PayPal. Update the plan?');
    await page.click('#ask-form button');
    const release = await waitFor(async () => (await apiState(base)).confirmations.find((c: any) => c.kind === 'apply_schedule' && c.status === 'pending' && c.preview_id === `pv_release_INV-2_${TODAY}`), 20_000, 'release card');
    await page.waitForSelector(`[data-confirmation="${release.id}"] button[data-action=approve]`);
    await page.click(`[data-confirmation="${release.id}"] button[data-action=approve]`);
    await waitReport(page, 'apply', release.id);
    const released = await engineDates(page);
    assert.deepEqual(pick(released, ['acme-t2', 'acme-build']), { 'acme-t2': { start: TODAY, end: TODAY }, 'acme-build': { start: TODAY, end: '2026-11-24' } });
    s = await apiState(base);
    assert.deepEqual(released, s.schedule);
    assert.deepEqual(s.blocked, []);
    assert.equal(s.invoices.find((i: any) => i.invoice_number === 'INV-2').status, 'MARKED_AS_PAID');
    assert.ok(s.audit.some((e: any) => e.action === 'engine.verified' && e.details.confirmation_id === release.id && e.details.mismatches.length === 0));
    assert.deepEqual(errors, []);
    shots.push(await shot(page, 'S6-real-sandbox-released'));
    await context.close();

    if (!STUB) writeEvidence('sandbox-live-flow', {
      paypal: { base_url: client.baseUrl, app_id: client.appId, public_default_credentials: client.appId === PUBLIC_DEFAULT_APP_ID, credentials_source: lookup.source, prefix },
      seeded: seeded.map((r) => ({ number: prefix + r.invoice_number, id: r.id, status: r.status, due: r.due_date, actions: r.actions })),
      inv2_from_paypal: { id: fromPayPal.id, status: fromPayPal.status, payment: payment && { type: payment.type, method: payment.method, payment_date: payment.payment_date, amount: payment.amount } },
      confirmations: s.confirmations.map((c: any) => ({ id: c.id, kind: c.kind, status: c.status, preview_id: c.preview_id })),
      engine_after_release: pick(released, ACME),
      audit_actions: s.audit.map((e: any) => e.action),
      paypal_requests: { seed: callsAfterSeed, record_payment_and_poll: paymentCalls, total_in_test_before_cleanup: client.requestCount },
      screenshots: shots,
    });
  } finally {
    await app.close();
    // Be gentle with the (possibly shared) app: remove the draft, cancel what is still unpaid. Paid ones cannot be cancelled.
    for (const r of seeded) {
      try {
        if (r.status === 'DRAFT') await client.deleteDraft(r.id);
        else if (r.status === 'UNPAID' && !(paid && r.invoice_number === 'INV-2')) await client.cancelInvoice(r.id, { send_to_recipient: false });
      } catch (err) { console.log(`cleanup ${prefix}${r.invoice_number}: ${client.mask((err as Error).message)}`); }
    }
    console.log(`${stub ? 'STUB dry run: ' : ''}PayPal requests in this test (incl. cleanup): ${client.requestCount}; prefix ${prefix}; app ${client.appId}`);
    await stub?.close();
  }
});
