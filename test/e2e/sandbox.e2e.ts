// SANDBOX mode through the real UI (Chrome via playwright-core) with the SCRIPTED agent, against the LOCAL STUB of the
// PayPal Invoicing v2 API (test/unit/helpers/paypalStub.ts) — not api-m.sandbox.paypal.com, which needs credentials
// that do not exist yet. It proves the mode switch, badge, polling and demo controls end to end, nothing more.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ScriptedAgent } from '../../src/agent/scripted.ts';
import { SandboxInvoicingClient } from '../../src/paypal/sandboxClient.ts';
import { seedSandbox } from '../../src/paypal/sandboxSeed.ts';
import { startPayPalStub } from '../unit/helpers/paypalStub.ts';
import { apiState, engineDates, launch, openBoard, shot, startApp, trialWatermark, waitFor, writeEvidence, type Browser } from './harness.ts';

let browser: Browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

test('sandbox mode (local stub API): badge says SANDBOX · local stub, plan comes from seeded invoices, "Record bank transfer" calls the API and the next poll reports PAID', async () => {
  const creds = { clientId: 'e2e-fake-client-id', clientSecret: 'e2e-fake-client-secret' };
  const stub = await startPayPalStub({ ...creds, today: '2026-11-03' });
  const client = new SandboxInvoicingClient({ credentials: creds, baseUrl: stub.baseUrl, today: () => '2026-11-03', log: () => {}, sleep: async () => {} });
  const seeded = await seedSandbox(client, { demoToday: '2026-11-03', realToday: '2026-11-03' });
  const { app, base } = await startApp({ today: '2026-11-03', invoicing: client, realToday: () => '2026-11-03', agent: (h: any) => new ScriptedAgent(h) });
  try {
    const { page, context, errors } = await openBoard(browser, base);
    let s = await apiState(base);
    assert.equal(s.modes.paypal, 'sandbox');
    assert.equal(s.modes.paypal_endpoint, stub.baseUrl);
    const pill = await page.$eval('#paypal-mode', (e) => ({ text: (e as HTMLElement).innerText, cls: e.className, title: (e as HTMLElement).title }));
    assert.deepEqual([pill.text, pill.cls], ['PayPal: SANDBOX API · local stub', 'pill sandbox']);
    assert.ok(pill.title.includes(stub.baseUrl));
    assert.equal(await page.$eval('button[data-sim="payer_pays"]', (b) => (b as HTMLButtonElement).disabled), true);
    const engine = await engineDates(page);
    assert.deepEqual(engine, s.schedule);
    assert.deepEqual(engine['acme-build'], { start: '2026-10-25', end: '2026-11-15' });
    assert.deepEqual(await trialWatermark(page), ['#gantt: Trial Version watermark present', '#capacity: Trial Version watermark present']);

    await page.click('details.demo > summary');
    await page.selectOption('#sim-invoice', 'INV-2');
    const before = stub.calls('POST', /\/payments$/).length;
    await page.click('button[data-sim="record_external_payment"]');
    s = await waitFor(async () => { const x = await apiState(base); return x.invoices.find((i: any) => i.invoice_number === 'INV-2').status === 'MARKED_AS_PAID' && x; }, 20_000, 'INV-2 MARKED_AS_PAID via stub');
    const payments = stub.calls('POST', /\/payments$/).slice(before);
    assert.equal(payments.length, 1);
    assert.equal(payments[0].json.method, 'BANK_TRANSFER');
    assert.equal(payments[0].json.payment_date, '2026-11-03');
    assert.equal(await page.$eval('details.demo > summary', (e) => (e as HTMLElement).innerText), 'Demo controls — sandbox API calls to the local stub');
    assert.ok(s.events.some((e: any) => e.invoice_number === 'INV-2' && e.event_type === 'INVOICING.INVOICE.PAID' && e.source === 'sandbox-poll'));
    assert.equal(s.audit.filter((a: any) => a.action === 'sandbox.demo_control').length, 1);
    // The plan does not move by itself: a payment only sweeps pending cards / wakes the agent; the engine still agrees.
    await page.waitForTimeout(300);
    assert.deepEqual(await engineDates(page), (await apiState(base)).schedule);
    assert.deepEqual(errors, []);
    const path = await shot(page, '08-sandbox-mode-local-stub');
    writeEvidence('08-sandbox-mode-local-stub', {
      paypal_backend: `LOCAL STUB ${stub.baseUrl} (test/unit/helpers/paypalStub.ts); NOT api-m.sandbox.paypal.com`,
      seeded: seeded.map((r) => [r.invoice_number, r.status, r.actions.join('>')]),
      badge: pill, stub_requests: stub.requests.map((r) => `${r.method} ${r.path}`), screenshot: path,
    });
    await context.close();
  } finally { await app.close(); await stub.close(); }
});
