// Seed and smoke routines for the real PayPal sandbox (scripts/sandbox-seed.ts, scripts/sandbox-smoke.ts).
// They take an already-built SandboxInvoicingClient, so the stub-server unit tests run exactly this code.
import { daysOverdue, findInvoice, isPaid } from '../domain/schedule.ts';
import { MOCK_INVOICES, PROJECTS } from '../domain/mockData.ts';
import type { PayPalInvoice } from '../domain/types.ts';
import { InvoicingError } from './invoicing.ts';
import { SEED_REFERENCE, type SandboxInvoicingClient } from './sandboxClient.ts';

const minDate = (a: string, b: string) => (a <= b ? a : b);
export const isoToday = () => new Date().toISOString().slice(0, 10);

/** Invoice numbers the demo board needs (one per tranche milestone). */
export function requiredInvoiceNumbers() {
  return PROJECTS.flatMap((p) => p.steps.flatMap((s) => (s.kind === 'tranche' ? [s.invoiceNumber] : [])));
}

export function missingDemoInvoices(invoices: PayPalInvoice[]) {
  return requiredInvoiceNumbers().filter((n) => !findInvoice(invoices, n));
}

// DRAFT < sent/awaiting payment < paid. Anything else (cancelled, refunded) is "drift" the seed will not undo.
const STAGE: Record<string, number> = { DRAFT: 0, SCHEDULED: 1, SENT: 1, UNPAID: 1, SHARED: 1, PAYMENT_PENDING: 1, PARTIALLY_PAID: 1, PAID: 2, MARKED_AS_PAID: 2, PAID_EXTERNAL: 2 };

export type SeedRow = {
  invoice_number: string; id: string; target: string; status: string; due_date: string;
  days_overdue_on_demo_clock: number; paid_date?: string; actions: string[]; note?: string;
};

// A PayPal 4xx about the due date (the spec does not say whether a past due_date is accepted; see FACTS_PAYPAL_INVOICING §7).
const dueDateRejected = (err: unknown) => err instanceof InvoicingError && err.status >= 400 && err.status < 500 && /due/i.test(`${err.issue} ${err.message}`);

/**
 * Brings the sandbox to the demo's starting state, idempotently:
 * every invoice is looked up by its prefixed invoice_number first and only created when missing; existing invoices
 * are only moved forward (DRAFT → sent → paid), never reset.
 */
export async function seedSandbox(client: SandboxInvoicingClient, opts: { demoToday: string; realToday?: string }) {
  const realToday = opts.realToday || isoToday();
  const rows: SeedRow[] = [];
  for (const target of MOCK_INVOICES) {
    const num = target.detail.invoice_number;
    const actions: string[] = [];
    let note: string | undefined;
    let inv = (await client.searchInvoices({ invoice_number: num })).find((i) => i.detail.invoice_number === num);
    if (inv) actions.push('found');
    else {
      const due = target.detail.payment_term.due_date;
      // A future issue date would make /send schedule the invoice instead of sending it (INV:340), so clamp to today.
      const draft = {
        invoice_number: num,
        invoice_date: minDate(target.detail.invoice_date, realToday),
        recipient: target.primary_recipients[0].billing_info,
        item: { name: `${num} delivery tranche`, amount: target.amount },
        note: 'Tranche demo invoice (PayPal sandbox). No real money.',
      };
      try {
        inv = await client.createDraft({ ...draft, due_date: due, reference: SEED_REFERENCE });
        actions.push('created');
      } catch (err) {
        if (!dueDateRejected(err)) throw err;
        // Fallback: PayPal keeps the invoice DUE_ON_RECEIPT and Tranche reads the planned due date from the reference tag.
        inv = await client.createDraft({ ...draft, reference: `${SEED_REFERENCE} due=${due}` });
        actions.push('created(due-date fallback)');
        note = `PayPal rejected due_date ${due}: ${(err as Error).message}`;
      }
    }
    const want = STAGE[target.status] ?? 0;
    const have = STAGE[inv.status];
    if (have === undefined || have > want) {
      note = `DRIFT: sandbox status ${inv.status}, demo wants ${target.status}. Not changed; set TRANCHE_INVOICE_PREFIX to seed a fresh set.`;
    } else {
      if (have === 0 && want >= 1) {
        // Share-link send: no PayPal email goes to the fictional .example recipients (INV:340 send_to_recipient=false).
        await client.sendInvoice(inv.id, { send_to_recipient: false, send_to_invoicer: false });
        actions.push('sent');
      }
      const now = want === 2 ? (await client.getInvoice(inv.id)).status : inv.status;
      if (want === 2 && now === 'PARTIALLY_PAID') note = 'PARTIALLY_PAID in the sandbox; the seed does not top up partial payments.';
      else if (want === 2 && (STAGE[now] ?? 0) < 2) {
        const paidOn = target.payments?.transactions.at(-1)?.payment_date || target.detail.invoice_date;
        // Recording an external payment needs no sandbox buyer (INV:742-745: "If no payment is due, the invoice is marked as PAID").
        await client.recordPayment(inv.id, { method: 'BANK_TRANSFER', payment_date: minDate(paidOn, realToday), amount: target.amount, note: 'Tranche demo seed: payment recorded via API' });
        actions.push('payment recorded');
      }
      inv = await client.getInvoice(inv.id);
    }
    rows.push({
      invoice_number: num, id: inv.id, target: target.status, status: inv.status, due_date: inv.detail.payment_term.due_date,
      days_overdue_on_demo_clock: daysOverdue(inv, opts.demoToday),
      ...(isPaid(inv) ? { paid_date: inv.payments?.transactions.at(-1)?.payment_date } : {}),
      actions, ...(note ? { note } : {}),
    });
  }
  return rows;
}

export type SmokeStep = { step: string; ok: boolean; detail: string };

/** Read-only checks plus one draft invoice that is always deleted again. */
export async function smokeSandbox(client: SandboxInvoicingClient, opts: { realToday?: string; tag?: string } = {}) {
  const realToday = opts.realToday || isoToday();
  const steps: SmokeStep[] = [];
  const listed = await client.listInvoices(1, 20);
  steps.push({ step: 'oauth token + GET /v2/invoicing/invoices', ok: true, detail: `${listed.invoices.length} ${client.prefix}* invoice(s) on page 1` });
  const found = await client.searchInvoices();
  const missing = missingDemoInvoices(found);
  steps.push({ step: 'POST /v2/invoicing/search-invoices', ok: true, detail: `${found.length} ${client.prefix}* invoice(s); demo set ${missing.length ? `missing ${missing.join(', ')} (run npm run sandbox:seed)` : 'complete'}` });
  const number = `SMOKE-${opts.tag || Date.now().toString(36).toUpperCase()}`;
  let draftId: string | undefined;
  try {
    const due = new Date(Date.parse(`${realToday}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10);
    const draft = await client.createDraft({ invoice_number: number, invoice_date: realToday, due_date: due, reference: 'tranche-smoke', recipient: { business_name: 'Tranche Smoke Test', email_address: 'smoke@tranche.example' }, item: { name: 'Smoke test (deleted again)', amount: { currency_code: 'EUR', value: '1.00' } } });
    draftId = draft.id;
    steps.push({ step: 'POST /v2/invoicing/invoices (draft)', ok: draft.status === 'DRAFT', detail: `${draft.id} ${draft.status}` });
    const got = await client.getInvoice(draft.id);
    steps.push({ step: 'GET /v2/invoicing/invoices/{id}', ok: got.detail.invoice_number === number, detail: `${got.detail.invoice_number} due ${got.detail.payment_term.due_date}` });
  } finally {
    if (draftId) {
      await client.deleteDraft(draftId);
      let gone = false;
      try { await client.getInvoice(draftId); } catch (err) { gone = err instanceof InvoicingError && err.status === 404; }
      steps.push({ step: 'DELETE /v2/invoicing/invoices/{id} (cleanup)', ok: gone, detail: gone ? `${draftId} deleted (GET now 404)` : `${draftId} still readable after DELETE` });
    }
  }
  return steps;
}
