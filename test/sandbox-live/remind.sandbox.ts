// OPT-IN, REAL PayPal sandbox: `npm run test:sandbox-remind` (sets LIVE_PAYPAL_REMIND=1). Not part of `npm run test:e2e`
// or `npm run test:sandbox-live`. It uses the demo set saved by `npm run sandbox:seed` (.tranche/sandbox-state.json) and
// drives ONE reminder through the real UI: the (scripted) agent files a reminder card for the not-yet-due INV-5, the
// owner clicks "Send PayPal reminder", and the server calls POST /v2/invoicing/invoices/{id}/remind. No polling, so
// the whole test costs about 6 PayPal requests. LIVE_PAYPAL_REMIND=stub runs it against the local stub (no evidence).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { ScriptedAgent } from '../../src/agent/scripted.ts';
import { SandboxInvoicingClient, newDemoPrefix, sandboxClientFromEnv } from '../../src/paypal/sandboxClient.ts';
import { seedSandbox } from '../../src/paypal/sandboxSeed.ts';
import { startPayPalStub } from '../unit/helpers/paypalStub.ts';
import { apiState, launch, openBoard, shot as realShot, startApp, waitFor, writeEvidence, type Browser } from '../e2e/harness.ts';

const STUB = process.env.LIVE_PAYPAL_REMIND === 'stub';
const LIVE = process.env.LIVE_PAYPAL_REMIND === '1' || STUB;
const TODAY = '2026-11-03';
const TARGET = 'INV-5';

let browser: Browser;
before(async () => { if (LIVE) browser = await launch(); });
after(async () => { await browser?.close(); });

test('REAL PayPal sandbox through the UI: agent files a reminder card → owner approves → POST …/remind', { skip: LIVE ? false : 'set LIVE_PAYPAL_REMIND=1 (npm run test:sandbox-remind)' }, async () => {
  const stub = STUB ? await startPayPalStub({ clientId: 'stub-id', clientSecret: 'stub-secret', today: TODAY }) : undefined;
  let client: SandboxInvoicingClient | undefined;
  if (stub) {
    client = new SandboxInvoicingClient({ credentials: { clientId: 'stub-id', clientSecret: 'stub-secret' }, baseUrl: stub.baseUrl, prefix: newDemoPrefix(), today: () => TODAY, log: () => {}, sleep: async () => {} });
    await seedSandbox(client, { demoToday: TODAY });
  } else {
    const r = sandboxClientFromEnv({ today: () => TODAY });
    assert.ok(r.client, `NO CREDENTIALS (${r.lookup.file})`);
    client = r.client;
    assert.equal(client.baseUrl, 'https://api-m.sandbox.paypal.com');
  }
  const ledger = process.env.TRANCHE_PAYPAL_CALL_LOG;
  const ledgerStart = ledger && existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').length : 0;
  const requestsBefore = client.requestCount;
  // pollMs omitted: one PayPal snapshot at start-up, no background polling.
  const { app, base } = await startApp({ today: TODAY, invoicing: client, agent: (h: any) => new ScriptedAgent(h) });
  try {
    const { page, errors } = await openBoard(browser, base);
    let s = await apiState(base);
    const inv5 = s.invoices.find((i: any) => i.invoice_number === TARGET);
    assert.equal(inv5.status, 'UNPAID', `${client.prefix}${TARGET} must be UNPAID; run npm run sandbox:seed`);
    assert.equal(inv5.reminders_sent_today, 0);
    assert.deepEqual(s.invoices.map((i: any) => i.invoice_number), ['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-5']);

    await page.fill('#ask-input', `Draft a friendly PayPal reminder for ${TARGET} (Birch & Pine Studio).`);
    await page.click('#ask-form button[type=submit]');
    const card = await waitFor(async () => (await apiState(base)).confirmations.find((c: any) => c.kind === 'send_reminder' && c.invoice_number === TARGET && c.status === 'pending'), 20_000, 'reminder card');
    assert.equal(card.requested_by, 'scripted');
    assert.match(await page.textContent('#poll-note') ?? '', /no background polling/);
    assert.match(card.payload_hash, /^[0-9a-f]{64}$/);
    await page.waitForSelector(`[data-confirmation="${card.id}"] button[data-action=approve]`);
    const auditBefore = (await apiState(base)).audit.length;
    await page.click(`[data-confirmation="${card.id}"] button[data-action=approve]`);
    s = await waitFor(async () => { const x = await apiState(base); return x.confirmations.find((c: any) => c.id === card.id).status === 'approved' && x.audit.some((e: any) => e.action === 'paypal.invoice.remind') && x; }, 60_000, 'reminder approved and sent');
    const remind = s.audit.find((e: any) => e.action === 'paypal.invoice.remind');
    assert.deepEqual([remind.details.invoice_id, remind.details.invoice_number, remind.details.mode, remind.details.endpoint], [inv5.invoice_id, TARGET, 'sandbox', 'POST /v2/invoicing/invoices/{invoice_id}/remind']);
    assert.ok(s.audit.slice(auditBefore).some((e: any) => e.action === 'confirmation.approved' && e.details.id === card.id));
    const after5 = s.invoices.find((i: any) => i.invoice_number === TARGET);
    assert.equal(after5.reminders_sent_today, 1);
    // What PayPal says about the invoice after the reminder (fresh GET, not the board copy).
    const fromPayPal = await client.getInvoice(inv5.invoice_id);
    assert.equal(fromPayPal.status, 'UNPAID');
    await page.waitForSelector(`[data-confirmation="${card.id}"].conf.approved`);
    const shotPath = STUB ? '(stub dry run, not written)' : await realShot(page, 'S7-real-sandbox-reminder-sent');
    assert.deepEqual(errors, []);
    const lines = ledger && existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').slice(ledgerStart).map((l) => JSON.parse(l)) : [];
    const remindLine = lines.find((l) => /\/remind$/.test(l.path));
    if (!STUB) {
      assert.ok(remindLine, 'ledger has the remind request (set TRANCHE_PAYPAL_CALL_LOG)');
      assert.equal(remindLine.status, 204);
      writeEvidence('sandbox-remind-flow', {
        endpoint: client.baseUrl, app_id: client.appId, prefix: client.prefix,
        invoice: { number: client.prefix + TARGET, id: inv5.invoice_id, status_before: inv5.status, status_after_from_paypal: fromPayPal.status },
        confirmation: { id: card.id, kind: card.kind, requested_by: card.requested_by, payload_hash: card.payload_hash, status: 'approved' },
        audit_remind: remind,
        remind_request: remindLine,
        paypal_requests_in_test: client.requestCount - requestsBefore,
        screenshot: STUB ? shotPath : relative(process.cwd(), shotPath),
      });
    }
    console.log(`${STUB ? 'STUB dry run: ' : ''}PayPal requests in this test: ${client.requestCount - requestsBefore}; remind → ${remindLine ? `${remindLine.status} debug ${remindLine.debug_id}` : 'n/a'}`);
  } finally {
    await app.close();
    await stub?.close();
  }
});
