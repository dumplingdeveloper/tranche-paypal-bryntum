// `npm run sandbox:probe`: answers the open questions in docs/FACTS_PAYPAL_INVOICING.md §8 against the REAL
// PayPal sandbox with about 15 requests, and writes what PayPal answered to artifacts/sandbox/probe-<date>.json.
// Everything it creates carries a unique `TRP-<tag>-` invoice number, a fake business name and an @example.com
// recipient. Exit 2 with "NO CREDENTIALS" and no network call when credentials are missing.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InvoicingError } from '../src/paypal/invoicing.ts';
import { sandboxClientFromEnv } from '../src/paypal/sandboxClient.ts';
import { isoToday } from '../src/paypal/sandboxSeed.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tag = Date.now().toString(36).toUpperCase().slice(-5);
const prefix = `TRP-${tag}-`;
const { client, lookup } = sandboxClientFromEnv({ prefix, log: () => {} });
if (!client) {
  console.error(`NO CREDENTIALS: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET, or create ${lookup.file} (chmod 600). Nothing was sent to PayPal.`);
  process.exit(2);
}
const today = isoToday();
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const recipient = { business_name: 'Tranche Probe Ltd (fake)', email_address: 'probe@example.com' };
const item = { name: 'Tranche fact probe', amount: { currency_code: 'EUR', value: '10.00' } };
type Step = { step: string; ok: boolean; answer: unknown; error?: { status: number; issue: string; message: string; debug_id?: string } };
const steps: Step[] = [];
async function run<T>(step: string, fn: () => Promise<T>, answer: (v: T) => unknown = (v) => v): Promise<T | undefined> {
  try {
    const v = await fn();
    steps.push({ step, ok: true, answer: answer(v) });
    return v;
  } catch (err) {
    const e = err as InvoicingError;
    steps.push({ step, ok: false, answer: null, error: { status: e.status ?? 0, issue: e.issue ?? 'ERROR', message: client!.mask(String(e.message)), debug_id: e.debugId } });
    return undefined;
  }
}

const pastDue = addDays(today, -9);
const a = await run('create draft with PAST due_date', () => client.createDraft({ invoice_number: 'PAST', invoice_date: addDays(today, -16), due_date: pastDue, reference: `tranche-probe/${tag}`, recipient, item }),
  (v) => ({ id: v.id, status: v.status, sent_due_date: pastDue, returned_due_date: v.detail.payment_term.due_date, returned_term_type: v.detail.payment_term.term_type, representation_returned: (client.calls.at(-1)?.detail as any)?.representation }));
await run('create draft with the SAME invoice_number again', () => client.createDraft({ invoice_number: 'PAST', invoice_date: today, due_date: addDays(today, 7), reference: `tranche-probe/${tag}`, recipient, item }),
  (v) => ({ id: v.id, status: v.status, invoice_number: `${prefix}PAST` })).then(async (dup) => { if (dup) await run('delete the duplicate draft', () => client.deleteDraft(dup.id), () => 'deleted'); });
await run('search invoice_number = full number', () => client.searchRaw({ invoice_number: `${prefix}PAST` }));
await run('search invoice_number = prefix only', () => client.searchRaw({ invoice_number: prefix }));
await run('search invoice_number = middle substring', () => client.searchRaw({ invoice_number: `${tag}-PAS` }));
if (a) {
  await run('send (send_to_recipient=false, send_to_invoicer=false)', () => client.sendInvoice(a.id, { send_to_recipient: false, send_to_invoicer: false }), () => 'ok');
  await run('status after send', () => client.getInvoice(a.id), (v) => ({ status: v.status, due_date: v.detail.payment_term.due_date }));
  await run('remind (send_to_recipient=true) on the sent invoice', () => client.remindInvoice(a.id, { send_to_recipient: true }), () => 'ok');
  const future = addDays(today, 8);
  const pay = await run(`record external payment dated in the FUTURE (${future})`, () => client.recordPayment(a.id, { method: 'BANK_TRANSFER', payment_date: future, amount: item.amount, note: 'Tranche probe' }));
  if (!pay) await run(`record external payment dated today (${today})`, () => client.recordPayment(a.id, { method: 'BANK_TRANSFER', payment_date: today, amount: item.amount, note: 'Tranche probe' }));
  await run('status after record-payment', () => client.getInvoice(a.id), (v) => ({ status: v.status, paid: v.payments?.paid_amount, transactions: v.payments?.transactions }));
  await run('cancel the paid probe invoice (cleanup attempt)', () => client.cancelInvoice(a.id, { send_to_recipient: false }), () => 'cancelled');
  await run('status after cancel attempt', () => client.getInvoice(a.id), (v) => ({ status: v.status }));
}

const out = { at: new Date().toISOString(), base_url: client.baseUrl, credentials_source: lookup.source, prefix, real_today: today, requests_sent: client.requestCount, steps };
const file = resolve(ROOT, `artifacts/sandbox/probe-${today}-${tag}.json`);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
for (const s of steps) console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.step}: ${JSON.stringify(s.ok ? s.answer : s.error)}`);
console.log(`requests sent to PayPal: ${client.requestCount}; written ${file.slice(ROOT.length + 1)}`);
