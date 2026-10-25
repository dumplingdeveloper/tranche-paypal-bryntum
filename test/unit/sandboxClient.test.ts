// SandboxInvoicingClient against a local stub server (test/unit/helpers/paypalStub.ts). No PayPal credentials and no
// network beyond 127.0.0.1. The fake credentials below are random test strings, not PayPal values.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { InvoicingError } from '../../src/paypal/invoicing.ts';
import { SandboxInvoicingClient, invoicePrefixFromEnv, loadSandboxCredentials, sandboxClientFromEnv, toDomainInvoice, toDomainStatus } from '../../src/paypal/sandboxClient.ts';
import { missingDemoInvoices, seedSandbox, smokeSandbox } from '../../src/paypal/sandboxSeed.ts';
import { daysOverdue, isPaid } from '../../src/domain/schedule.ts';
import { createTranche } from '../../src/server/app.ts';
import { ScriptedAgent } from '../../src/agent/scripted.ts';
import { startPayPalStub } from './helpers/paypalStub.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const ID = 'AfakeClientId-7Qx2LmN9pR4tV8wZ';
const SECRET = 'EfakeSecret-K3sD9fJ2hG6bN1mQ';
const TOKEN = 'A21AAfakeAccessToken-u7Y3t';
const stubs: Array<{ close: () => Promise<void> }> = [];
after(async () => { for (const s of stubs) await s.close(); });

async function setup(extra: Partial<Parameters<typeof startPayPalStub>[0]> = {}, clientOpts: Partial<ConstructorParameters<typeof SandboxInvoicingClient>[0]> = {}) {
  const stub = await startPayPalStub({ clientId: ID, clientSecret: SECRET, token: TOKEN, today: '2026-11-03', ...extra });
  stubs.push(stub);
  const logs: string[] = [];
  const sleeps: number[] = [];
  const client = new SandboxInvoicingClient({
    credentials: { clientId: ID, clientSecret: SECRET }, baseUrl: stub.baseUrl, today: () => '2026-11-03',
    log: (l) => logs.push(l), sleep: async (ms) => { sleeps.push(ms); }, ...clientOpts,
  });
  return { stub, client, logs, sleeps };
}

const draft = (n: string, over: Record<string, unknown> = {}) => ({
  invoice_number: n, invoice_date: '2026-10-11', due_date: '2026-10-25',
  recipient: { business_name: 'Acme Coffee Roasters', email_address: 'accounts@acme-coffee.example' },
  item: { name: `${n} tranche`, amount: { currency_code: 'EUR', value: '4800.00' } }, ...over,
});

test('OAuth: client_credentials with HTTP Basic, token cached and shared by concurrent calls', async () => {
  const { stub, client } = await setup();
  await Promise.all([client.searchInvoices(), client.searchInvoices(), client.listInvoices()]);
  await client.searchInvoices();
  const tokenCalls = stub.calls('POST', '/v1/oauth2/token');
  assert.equal(tokenCalls.length, 1);
  assert.equal(tokenCalls[0].headers.authorization, `Basic ${Buffer.from(`${ID}:${SECRET}`).toString('base64')}`);
  assert.equal(tokenCalls[0].headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(tokenCalls[0].body, 'grant_type=client_credentials');
  for (const r of stub.requests.filter((x) => x.path !== '/v1/oauth2/token')) assert.equal(r.headers.authorization, `Bearer ${TOKEN}-1`);
});

test('OAuth: a token is refreshed when expires_in has run out (60 s safety margin)', async () => {
  const { stub, client } = await setup({ expiresIn: 60 });
  await client.searchInvoices();
  await client.searchInvoices();
  assert.equal(stub.calls('POST', '/v1/oauth2/token').length, 2);
});

test('OAuth: one 401 on an API call fetches a new token and retries once', async () => {
  const { stub, client } = await setup();
  await client.searchInvoices();
  stub.fail({ method: 'POST', path: /search-invoices/, status: 401, body: { error: 'invalid_token' } });
  assert.deepEqual(await client.searchInvoices(), []);
  assert.equal(stub.calls('POST', '/v1/oauth2/token').length, 2);
  assert.equal(stub.calls('POST', '/v2/invoicing/search-invoices').length, 3);
});

test('createDraft: POST /v2/invoicing/invoices with Prefer: return=representation and the spec body shape', async () => {
  const { stub, client } = await setup();
  const inv = await client.createDraft(draft('INV-2'));
  const [req] = stub.calls('POST', '/v2/invoicing/invoices');
  assert.equal(req.headers.prefer, 'return=representation');
  assert.equal(req.headers['content-type'], 'application/json');
  assert.deepEqual(req.json, {
    detail: { invoice_number: 'TRANCHE-INV-2', reference: 'tranche-demo/v1', currency_code: 'EUR', invoice_date: '2026-10-11', payment_term: { due_date: '2026-10-25' } },
    primary_recipients: [{ billing_info: { business_name: 'Acme Coffee Roasters', email_address: 'accounts@acme-coffee.example' } }],
    items: [{ name: 'INV-2 tranche', quantity: '1', unit_amount: { currency_code: 'EUR', value: '4800.00' } }],
  });
  assert.match(inv.id, /^INV2-[A-Z0-9-]{19}$/); // invoice_id pattern in the spec
  assert.equal(inv.status, 'DRAFT');
  assert.equal(inv.detail.invoice_number, 'INV-2');
  assert.equal(inv.detail.payment_term.due_date, '2026-10-25');
  assert.deepEqual(inv.amount, { currency_code: 'EUR', value: '4800.00' });
  assert.deepEqual(client.calls.map((c) => c.op), ['create_draft']);
});

test('createDraft: when PayPal answers with a link only (INV:104) the client GETs the invoice', async () => {
  const { stub, client } = await setup({ linkOnly: true });
  const inv = await client.createDraft(draft('INV-9'));
  assert.equal(inv.detail.invoice_number, 'INV-9');
  assert.equal(stub.calls('GET', new RegExp(`/v2/invoicing/invoices/${inv.id}$`)).length, 1);
});

test('send / remind / record payment / refund / cancel / delete: method, path, body and resulting status', async () => {
  const { stub, client } = await setup();
  const a = await client.createDraft(draft('INV-2'));
  await client.sendInvoice(a.id, { send_to_recipient: false, send_to_invoicer: false });
  assert.deepEqual(stub.calls('POST', `/v2/invoicing/invoices/${a.id}/send`)[0].json, { send_to_recipient: false, send_to_invoicer: false });
  assert.equal((await client.getInvoice(a.id)).status, 'SENT');

  await client.remindInvoice(a.id);
  assert.deepEqual(stub.calls('POST', `/v2/invoicing/invoices/${a.id}/remind`)[0].json, { send_to_recipient: true });
  assert.equal(client.remindersOn(a.id), 1);
  assert.equal(client.remindersOn(a.id, '2026-11-04'), 0);

  const part = await client.recordPayment(a.id, { method: 'BANK_TRANSFER', payment_date: '2026-11-01', amount: { currency_code: 'EUR', value: '1000.00' } });
  assert.match(part.payment_id, /^EXTR-STUB-/);
  const partial = await client.getInvoice(a.id);
  assert.equal(partial.status, 'PARTIALLY_PAID');
  assert.equal(isPaid(partial), false);
  await client.recordPayment(a.id, { method: 'BANK_TRANSFER', payment_date: '2026-11-02' });
  const paid = await client.getInvoice(a.id);
  assert.equal(paid.status, 'PAID');
  assert.deepEqual(paid.payments?.transactions.map((t) => [t.payment_date, t.method, t.type]), [['2026-11-01', 'BANK_TRANSFER', 'EXTERNAL'], ['2026-11-02', 'BANK_TRANSFER', 'EXTERNAL']]);
  assert.equal(stub.calls('POST', `/v2/invoicing/invoices/${a.id}/payments`)[0].json.method, 'BANK_TRANSFER');

  const ref = await client.recordRefund(a.id, { method: 'BANK_TRANSFER', refund_date: '2026-11-03' });
  assert.match(ref.refund_id, /^EXTR-REF-STUB-/);
  assert.equal((await client.getInvoice(a.id)).status, 'REFUNDED');

  const b = await client.createDraft(draft('INV-5'));
  await client.sendInvoice(b.id);
  await client.cancelInvoice(b.id);
  assert.deepEqual(stub.calls('POST', `/v2/invoicing/invoices/${b.id}/cancel`)[0].json, { send_to_recipient: false });
  assert.equal((await client.getInvoice(b.id)).status, 'CANCELLED');

  const c = await client.createDraft(draft('SMOKE-X'));
  await client.deleteDraft(c.id);
  assert.equal(stub.calls('DELETE', `/v2/invoicing/invoices/${c.id}`).length, 1);
  assert.equal(stub.invoices.has(c.id), false);
  assert.deepEqual(client.calls.map((x) => x.op), ['create_draft', 'send', 'remind', 'record_payment', 'record_payment', 'record_refund', 'create_draft', 'send', 'cancel', 'create_draft', 'delete_draft']);
});

test('getInvoice also resolves a domain number (INV-2) through search', async () => {
  const { client } = await setup();
  const a = await client.createDraft(draft('INV-2'));
  assert.equal((await client.getInvoice('INV-2')).id, a.id);
  await assert.rejects(client.getInvoice('INV-7'), (e: InvoicingError) => e.status === 404);
});

test('search: paginates (page_size 100) and keeps only TRANCHE- invoices', async () => {
  const { stub, client } = await setup();
  for (let i = 0; i < 130; i++) stub.put({ id: `INV2-OTHR-0000-0000-${String(i).padStart(4, '0')}`, status: 'SENT', detail: { invoice_number: `OTHER-${i}`, currency_code: 'EUR', invoice_date: '2026-10-01' }, amount: { currency_code: 'EUR', value: '1.00' } });
  await client.createDraft(draft('INV-2'));
  const found = await client.searchInvoices();
  assert.deepEqual(found.map((i) => i.detail.invoice_number), ['INV-2']);
  const pages = stub.calls('POST', '/v2/invoicing/search-invoices');
  assert.deepEqual(pages.map((p) => [p.query.get('page'), p.query.get('page_size')]), [['1', '100'], ['2', '100']]);
  const listed = await client.listInvoices();
  assert.equal(listed.total_pages, 2);
  assert.deepEqual(listed.invoices.map((i) => i.detail.invoice_number), []); // INV-2 is item 131, on page 2
});

test('retry: 429 is retried even for POST, honouring Retry-After', async () => {
  const { stub, client, sleeps, logs } = await setup();
  const a = await client.createDraft(draft('INV-2'));
  stub.fail({ method: 'POST', path: /\/send$/, status: 429, headers: { 'retry-after': '2' }, body: { name: 'RATE_LIMIT_REACHED' } });
  await client.sendInvoice(a.id);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(stub.calls('POST', `/v2/invoicing/invoices/${a.id}/send`).length, 2);
  assert.match(logs.join('\n'), /→ 429; retry 1\/3 in 2000 ms \(PayPal-Debug-Id stubdebug\d+\)/);
});

test('retry: 5xx and network errors back off exponentially on reads; POST mutations are not retried on 5xx', async () => {
  const { stub, client, sleeps } = await setup();
  stub.fail({ method: 'POST', path: /search-invoices/, status: 503, times: 2, body: { name: 'SERVICE_UNAVAILABLE' } });
  stub.fail({ method: 'POST', path: /search-invoices/, status: 0, network: true });
  assert.deepEqual(await client.searchInvoices(), []);
  assert.deepEqual(sleeps, [500, 1000, 2000]);

  const a = await client.createDraft(draft('INV-2'));
  stub.fail({ method: 'POST', path: /\/remind$/, status: 500, body: { name: 'INTERNAL_SERVER_ERROR', message: 'boom', debug_id: 'dbg500' }, headers: { 'paypal-debug-id': 'dbg500' } });
  await assert.rejects(client.remindInvoice(a.id), (e: any) => e instanceof InvoicingError && e.status === 500 && e.debugId === 'dbg500');
  assert.equal(stub.calls('POST', `/v2/invoicing/invoices/${a.id}/remind`).length, 1);
  assert.equal(client.remindersOn(a.id), 0);

  stub.fail({ method: 'GET', path: /\/v2\/invoicing\/invoices\//, status: 502, times: 4, body: {} });
  await assert.rejects(client.getInvoice(a.id), (e: InvoicingError) => e.status === 502);
  assert.equal(stub.calls('GET', `/v2/invoicing/invoices/${a.id}`).length, 4); // 1 + maxRetries 3
});

test('errors: PayPal error body → InvoicingError with issue and PayPal-Debug-Id', async () => {
  const { client, logs } = await setup();
  await client.createDraft(draft('INV-2'));
  await assert.rejects(client.createDraft(draft('INV-2')), (e: any) => {
    assert.equal(e.status, 422);
    assert.equal(e.issue, 'STUB_DUPLICATE_INVOICE_NUMBER');
    assert.match(e.message, /POST \/v2\/invoicing\/invoices → 422 STUB_DUPLICATE_INVOICE_NUMBER: Invoice number already exists \(PayPal-Debug-Id stubdebug\d+\)/);
    assert.match(e.debugId, /^stubdebug\d+$/);
    return true;
  });
  assert.ok(logs.some((l) => l.includes('PayPal-Debug-Id stubdebug')));
});

test('secrets: client id, secret and access token never appear in logs or errors, even if PayPal echoes them', async () => {
  const { stub, client, logs } = await setup();
  await client.searchInvoices();
  const echo = `bad request: client_id=${ID} secret=${SECRET} token=${TOKEN}-1 basic=${Buffer.from(`${ID}:${SECRET}`).toString('base64')}`;
  stub.fail({ method: 'POST', path: /search-invoices/, status: 400, body: { name: 'INVALID_REQUEST', message: echo, details: [{ issue: 'INVALID_PARAMETER_VALUE', description: echo }] } });
  let caught: Error | undefined;
  try { await client.searchInvoices(); } catch (e) { caught = e as Error; }
  stub.fail({ method: 'POST', path: /search-invoices/, status: 0, network: true, times: 4 });
  let net: Error | undefined;
  try { await client.searchInvoices(); } catch (e) { net = e as Error; }
  const bad = await startPayPalStub({ clientId: ID, clientSecret: 'other', token: TOKEN });
  stubs.push(bad);
  const wrong = new SandboxInvoicingClient({ credentials: { clientId: ID, clientSecret: SECRET }, baseUrl: bad.baseUrl, log: (l) => logs.push(l), sleep: async () => {} });
  let auth: Error | undefined;
  try { await wrong.searchInvoices(); } catch (e) { auth = e as Error; }
  assert.ok(caught && net && auth);
  assert.equal((auth as InvoicingError).status, 401);
  const everything = [...logs, caught!.message, String(caught!.stack), net!.message, auth!.message, JSON.stringify(client.calls)].join('\n');
  for (const s of [ID, SECRET, `${TOKEN}-1`, Buffer.from(`${ID}:${SECRET}`).toString('base64')]) assert.equal(everything.includes(s), false, `leaked ${s.slice(0, 6)}…`);
  assert.match(caught!.message, /client_id=\*\*\* secret=\*\*\* token=\*\*\*/);
});

test('guards: no credentials → constructor refuses; only the sandbox host (or loopback for tests) is accepted', () => {
  assert.throws(() => new SandboxInvoicingClient({ credentials: { clientId: '', clientSecret: '' } }), /NO CREDENTIALS/);
  assert.throws(() => new SandboxInvoicingClient({ credentials: { clientId: ID, clientSecret: SECRET }, baseUrl: 'https://api-m.paypal.com' }), /Refusing PayPal base URL/);
  assert.equal(new SandboxInvoicingClient({ credentials: { clientId: ID, clientSecret: SECRET } }).baseUrl, 'https://api-m.sandbox.paypal.com');
  assert.equal(invoicePrefixFromEnv({}), 'TRANCHE-');
  assert.equal(invoicePrefixFromEnv({ TRANCHE_INVOICE_PREFIX: 'tr2-' }), 'TR2-');
  assert.throws(() => invoicePrefixFromEnv({ TRANCHE_INVOICE_PREFIX: 'WAY-TOO-LONG-PREFIX' }), /1-12/);
});

test('status mapping: every spec status kept; PAYMENT_PENDING / PARTIALLY_PAID block, MARKED_AS_PAID pays; unknown → UNPAID', () => {
  const statuses = ['DRAFT', 'SENT', 'SCHEDULED', 'PAID', 'MARKED_AS_PAID', 'CANCELLED', 'REFUNDED', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED', 'MARKED_AS_REFUNDED', 'UNPAID', 'PAYMENT_PENDING', 'AUTO_CANCELLED', 'PAID_EXTERNAL', 'REFUNDED_EXTERNAL', 'SHARED'];
  for (const s of statuses) assert.deepEqual(toDomainStatus(s), { status: s });
  assert.deepEqual(toDomainStatus('SOMETHING_NEW'), { status: 'UNPAID', unknown: 'SOMETHING_NEW' });
  const raw = (status: string, extra: any = {}) => ({ id: 'INV2-AAAA-BBBB-CCCC-DDDD', status, detail: { invoice_number: 'TRANCHE-INV-2', currency_code: 'EUR', invoice_date: '2026-10-11', payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: '2026-10-25' }, ...extra }, amount: { currency_code: 'EUR', value: '4800.00' } });
  const today = '2026-11-03';
  assert.equal(daysOverdue(toDomainInvoice(raw('SENT')), today), 9);
  assert.equal(daysOverdue(toDomainInvoice(raw('PAYMENT_PENDING')), today), 9);
  assert.equal(daysOverdue(toDomainInvoice(raw('PARTIALLY_PAID')), today), 9);
  assert.equal(daysOverdue(toDomainInvoice(raw('MARKED_AS_PAID')), today), 0);
  assert.equal(isPaid(toDomainInvoice(raw('MARKED_AS_PAID'))), true);
  assert.equal(isPaid(toDomainInvoice(raw('PAYMENT_PENDING'))), false);
  assert.equal(toDomainInvoice(raw('SENT')).detail.invoice_number, 'INV-2');
  // DUE_ON_RECEIPT fallback: due date read from the seed's reference tag, else the invoice date.
  const tagged = toDomainInvoice(raw('SENT', { payment_term: { term_type: 'DUE_ON_RECEIPT' }, reference: 'tranche-demo/v1 due=2026-10-25' }));
  assert.equal(tagged.detail.payment_term.due_date, '2026-10-25');
  assert.equal(daysOverdue(tagged, today), 9);
  assert.equal(toDomainInvoice(raw('SENT', { payment_term: { term_type: 'DUE_ON_RECEIPT' } })).detail.payment_term.due_date, '2026-10-11');
});

test('credentials: env overrides the file; loose file mode warns; nothing found → source none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tranche-creds-'));
  const file = join(dir, 'paypal-sandbox.env');
  assert.deepEqual(loadSandboxCredentials({}, file), { source: 'none', file, warnings: [] });
  writeFileSync(file, `# sandbox\nPAYPAL_CLIENT_ID=${ID}\nexport PAYPAL_CLIENT_SECRET="${SECRET}"\n`);
  chmodSync(file, 0o600);
  const f = loadSandboxCredentials({}, file);
  assert.deepEqual([f.source, f.creds, f.warnings], ['file', { clientId: ID, clientSecret: SECRET }, []]);
  const e = loadSandboxCredentials({ PAYPAL_CLIENT_ID: 'envId', PAYPAL_CLIENT_SECRET: 'envSecret' }, file);
  assert.deepEqual([e.source, e.creds], ['env', { clientId: 'envId', clientSecret: 'envSecret' }]);
  assert.equal(loadSandboxCredentials({ PAYPAL_CLIENT_ID: 'envId' }, file).source, 'env+file');
  chmodSync(file, 0o644);
  const loose = loadSandboxCredentials({}, file);
  assert.equal(loose.warnings.length, 1);
  assert.match(loose.warnings[0], /chmod 600/);
  assert.equal(loose.warnings[0].includes(SECRET), false);
});

test('no credentials → no client and no fetch at all', () => {
  let fetched = 0;
  const spy = (async () => { fetched++; throw new Error('no'); }) as unknown as typeof fetch;
  const r = sandboxClientFromEnv({ env: {}, file: join(tmpdir(), 'tranche-definitely-missing.env'), fetch: spy });
  assert.equal(r.client, undefined);
  assert.equal(r.lookup.source, 'none');
  assert.equal(fetched, 0);
});

test('no credentials: sandbox:seed, sandbox:smoke and TRANCHE_PAYPAL=sandbox start exit 2 "NO CREDENTIALS" with zero network activity', () => {
  const home = mkdtempSync(join(tmpdir(), 'tranche-home-'));
  const spyFile = join(home, 'net.log');
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, NET_SPY_FILE: spyFile, TRANCHE_PAYPAL: 'sandbox' };
  const node = (args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', resolve(ROOT, 'test/unit/helpers/netSpy.mjs'), ...args], { cwd: ROOT, env, encoding: 'utf8' });
  // Positive control: the spy does see a request.
  node(['-e', "fetch('http://127.0.0.1:9/').catch(() => {})"]);
  assert.match(readFileSync(spyFile, 'utf8'), /^fetch http:\/\/127\.0\.0\.1:9\//m);
  writeFileSync(spyFile, '');
  for (const script of ['scripts/sandbox-seed.ts', 'scripts/sandbox-smoke.ts', 'src/server/main.ts']) {
    const r = node([script]);
    assert.equal(r.status, 2, `${script}: ${r.stderr}`);
    assert.match(r.stderr, /^NO CREDENTIALS: /m, script);
    assert.equal(readFileSync(spyFile, 'utf8'), '', `${script} touched the network`);
  }
  assert.equal(existsSync(join(home, '.config')), false);
});

test('seed: reaches the demo states, is idempotent, and the demo clock makes INV-2 9 days overdue', async () => {
  const { stub, client } = await setup({ today: '2026-11-03' });
  const rows = await seedSandbox(client, { demoToday: '2026-11-03', realToday: '2026-11-03' });
  assert.deepEqual(rows.map((r) => [r.invoice_number, r.status, r.due_date, r.days_overdue_on_demo_clock, r.paid_date ?? null, r.actions.join('>')]), [
    ['INV-1', 'PAID', '2026-10-05', 0, '2026-10-04', 'created>sent>payment recorded'],
    ['INV-2', 'SENT', '2026-10-25', 9, null, 'created>sent'],
    ['INV-3', 'DRAFT', '2026-11-22', 0, null, 'created'],
    ['INV-4', 'PAID', '2026-10-22', 0, '2026-10-20', 'created>sent>payment recorded'],
    ['INV-5', 'SENT', '2026-11-16', 0, null, 'created>sent'],
  ]);
  // INV-3's issue date (2026-11-08) is after real today, so it is clamped (INV:340 would otherwise schedule it).
  assert.equal(stub.calls('POST', '/v2/invoicing/invoices')[2].json.detail.invoice_date, '2026-11-03');
  for (const r of stub.calls('POST', /\/send$/)) assert.deepEqual(r.json, { send_to_recipient: false, send_to_invoicer: false });
  const creates = stub.calls('POST', '/v2/invoicing/invoices').length;
  const again = await seedSandbox(client, { demoToday: '2026-11-03', realToday: '2026-11-03' });
  assert.deepEqual(again.map((r) => r.actions.join('>')), ['found', 'found', 'found', 'found', 'found']);
  assert.equal(stub.calls('POST', '/v2/invoicing/invoices').length, creates);
  assert.deepEqual(again.map((r) => r.status), rows.map((r) => r.status));
  assert.deepEqual(missingDemoInvoices(await client.searchInvoices()), []);
});

test('seed: if PayPal refuses a past due_date, falls back to DUE_ON_RECEIPT + reference tag (stub knob, real behaviour unverified)', async () => {
  const { stub, client } = await setup({ rejectPastDueDate: true, today: '2026-11-03' });
  const rows = await seedSandbox(client, { demoToday: '2026-11-03', realToday: '2026-11-03' });
  const inv2 = rows.find((r) => r.invoice_number === 'INV-2')!;
  assert.equal(inv2.actions[0], 'created(due-date fallback)');
  assert.equal(inv2.due_date, '2026-10-25');
  assert.equal(inv2.days_overdue_on_demo_clock, 9);
  const raw = [...stub.invoices.values()].find((x) => x.detail.invoice_number === 'TRANCHE-INV-2');
  assert.equal(raw.detail.reference, 'tranche-demo/v1 due=2026-10-25');
  assert.equal(raw.detail.payment_term.term_type, 'DUE_ON_RECEIPT');
  assert.equal(rows.find((r) => r.invoice_number === 'INV-5')!.actions[0], 'created'); // future due date accepted
});

test('seed: drift (e.g. INV-2 already paid during a demo) is reported and left alone', async () => {
  const { client } = await setup();
  await seedSandbox(client, { demoToday: '2026-11-03', realToday: '2026-11-03' });
  const inv2 = await client.getInvoice('INV-2');
  await client.recordPayment(inv2.id, { method: 'BANK_TRANSFER', payment_date: '2026-11-03' });
  const n = client.calls.length;
  const rows = await seedSandbox(client, { demoToday: '2026-11-03', realToday: '2026-11-03' });
  assert.match(rows.find((r) => r.invoice_number === 'INV-2')!.note || '', /^DRIFT: sandbox status PAID, demo wants SENT/);
  assert.equal(client.calls.length, n);
});

test('smoke: reads, creates one draft and always deletes it again', async () => {
  const { stub, client } = await setup();
  const steps = await smokeSandbox(client, { realToday: '2026-11-03', tag: 'T1' });
  assert.deepEqual(steps.map((s) => [s.step, s.ok]), [
    ['oauth token + GET /v2/invoicing/invoices', true],
    ['POST /v2/invoicing/search-invoices', true],
    ['POST /v2/invoicing/invoices (draft)', true],
    ['GET /v2/invoicing/invoices/{id}', true],
    ['DELETE /v2/invoicing/invoices/{id} (cleanup)', true],
  ]);
  assert.equal(stub.invoices.size, 0);
  assert.equal(stub.calls('POST', '/v2/invoicing/invoices')[0].json.detail.invoice_number, 'TRANCHE-SMOKE-T1');
  // Cleanup also runs when a step after the create fails.
  stub.fail({ method: 'GET', path: /\/v2\/invoicing\/invoices\/INV2-/, status: 400, body: { name: 'INVALID_REQUEST' } });
  await assert.rejects(smokeSandbox(client, { realToday: '2026-11-03', tag: 'T2' }), (e: InvoicingError) => e.status === 400);
  assert.equal(stub.invoices.size, 0);
});

test('app in sandbox mode: badge mode, polling watcher sees PayPal changes, payer_pays refused, demo controls call the API', async () => {
  const { stub, client } = await setup();
  await seedSandbox(client, { demoToday: '2026-11-03', realToday: '2026-11-03' });
  const app = await createTranche({ today: '2026-11-03', invoicing: client, agent: (h) => new ScriptedAgent(h) });
  try {
    const port = await app.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) });
    const state = async () => (await (await fetch(`${base}/api/state`)).json()) as any;
    let s = await state();
    assert.equal(s.modes.paypal, 'sandbox');
    assert.deepEqual(s.invoices.map((i: any) => [i.invoice_number, i.status]), [['INV-1', 'PAID'], ['INV-2', 'SENT'], ['INV-3', 'DRAFT'], ['INV-4', 'PAID'], ['INV-5', 'SENT']]);
    const pay = await post('/api/mock/simulate', { action: 'payer_pays', invoice_number: 'INV-2' });
    assert.equal(pay.status, 409);
    assert.equal(((await pay.json()) as any).error.code, 'NEEDS_BROWSER_PAYER');
    // A change made directly in PayPal (not via Tranche) is picked up by the next poll.
    const inv5 = [...stub.invoices.values()].find((x) => x.detail.invoice_number === 'TRANCHE-INV-5');
    inv5.status = 'PAYMENT_PENDING';
    const before = stub.calls('POST', '/v2/invoicing/search-invoices').length;
    assert.equal((await post('/api/mock/simulate', { action: 'record_external_payment', invoice_number: 'INV-2' })).status, 200);
    assert.ok(stub.calls('POST', '/v2/invoicing/search-invoices').length > before);
    assert.equal(stub.calls('POST', /\/payments$/).at(-1)!.json.method, 'BANK_TRANSFER');
    s = await state();
    assert.equal(s.invoices.find((i: any) => i.invoice_number === 'INV-2').status, 'PAID');
    assert.equal(s.invoices.find((i: any) => i.invoice_number === 'INV-5').status, 'PAYMENT_PENDING');
    const audit = s.audit.find((a: any) => a.action === 'sandbox.demo_control');
    assert.equal(audit.details.action, 'record_external_payment');
    assert.equal(audit.actor, 'demo-control');
    assert.ok(s.events.some((e: any) => e.invoice_number === 'INV-2' && e.event_type === 'INVOICING.INVOICE.PAID' && e.source === 'sandbox-poll'));
    assert.deepEqual(s.paypal_calls.at(-1).op, 'record_payment');
  } finally { await app.close(); }
});
