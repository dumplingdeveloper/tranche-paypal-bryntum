// Polls InvoicingClient.searchInvoices and turns status diffs into events shaped like PayPal's INVOICING.INVOICE.*
// webhooks (event names: https://developer.paypal.com/api/rest/webhooks/event-names/). Polling is the judge path
// because a webhook needs a URL PayPal can reach (WH:1699-1702). PayPal has no "overdue" event, so
// TRANCHE.INVOICE.OVERDUE is derived from the due date by our clock and is labelled as ours.
import type { InvoiceStatus, PayPalInvoice } from '../domain/types.ts';
import { daysOverdue, isPaid } from '../domain/schedule.ts';
import type { InvoicingClient } from './invoicing.ts';

export type PaymentEventType =
  | 'INVOICING.INVOICE.CREATED' | 'INVOICING.INVOICE.PAID' | 'INVOICING.INVOICE.REFUNDED' | 'INVOICING.INVOICE.CANCELLED'
  | 'INVOICING.INVOICE.SCHEDULED' | 'INVOICING.INVOICE.UPDATED' | 'TRANCHE.INVOICE.OVERDUE';

export type PaymentEvent = {
  id: string;
  event_type: PaymentEventType;
  source: 'mock-poll' | 'sandbox-poll' | 'tranche-clock';
  invoice_id: string;
  invoice_number: string;
  client: string;
  status_before?: InvoiceStatus;
  status_after: InvoiceStatus;
  days_overdue?: number;
  observed_on: string;
  initial: boolean;
  summary: string;
};

const PAID = new Set<InvoiceStatus>(['PAID', 'PARTIALLY_PAID', 'MARKED_AS_PAID', 'PAID_EXTERNAL', 'PAYMENT_PENDING']);
const REFUNDED = new Set<InvoiceStatus>(['REFUNDED', 'PARTIALLY_REFUNDED', 'MARKED_AS_REFUNDED', 'REFUNDED_EXTERNAL']);
const CANCELLED = new Set<InvoiceStatus>(['CANCELLED', 'AUTO_CANCELLED']);

// INVOICING.INVOICE.PAID: "An invoice is paid, partially paid, or payment is made and is pending." (event-names page)
export function eventTypeFor(before: InvoiceStatus | undefined, after: InvoiceStatus): PaymentEventType {
  if (!before) return 'INVOICING.INVOICE.CREATED';
  if (PAID.has(after)) return 'INVOICING.INVOICE.PAID';
  if (REFUNDED.has(after)) return 'INVOICING.INVOICE.REFUNDED';
  if (CANCELLED.has(after)) return 'INVOICING.INVOICE.CANCELLED';
  if (after === 'SCHEDULED') return 'INVOICING.INVOICE.SCHEDULED';
  return 'INVOICING.INVOICE.UPDATED';
}

export class PaymentWatcher {
  private last = new Map<string, InvoiceStatus>();
  private overdueSeen = new Set<string>();
  private seq = 0;
  private timer?: ReturnType<typeof setInterval>;
  private polling?: Promise<PaymentEvent[]>;
  invoices: PayPalInvoice[] = [];
  /** Ids seen before but absent from the latest search (e.g. a draft deleted in PayPal); their last copy is kept. */
  missing: string[] = [];
  readonly history: PaymentEvent[] = [];

  private client: InvoicingClient;
  private opts: { today: () => string; onEvents?: (events: PaymentEvent[], invoices: PayPalInvoice[]) => void };
  constructor(client: InvoicingClient, opts: { today: () => string; onEvents?: (events: PaymentEvent[], invoices: PayPalInvoice[]) => void }) { this.client = client; this.opts = opts; }

  private make(inv: PayPalInvoice, type: PaymentEventType, initial: boolean, before?: InvoiceStatus): PaymentEvent {
    const client = inv.primary_recipients[0]?.billing_info.business_name || '';
    const today = this.opts.today();
    const overdue = daysOverdue(inv, today);
    const source: PaymentEvent['source'] = type === 'TRANCHE.INVOICE.OVERDUE' ? 'tranche-clock' : this.client.mode === 'mock' ? 'mock-poll' : 'sandbox-poll';
    const summary = type === 'TRANCHE.INVOICE.OVERDUE'
      ? `${inv.detail.invoice_number} (${client}) is ${overdue} days overdue — due ${inv.detail.payment_term.due_date}, still ${inv.status}.`
      : before ? `${inv.detail.invoice_number} (${client}) ${before} → ${inv.status}.` : `${inv.detail.invoice_number} (${client}) seen as ${inv.status}.`;
    return {
      id: `EV-${String(++this.seq).padStart(4, '0')}`, event_type: type, source, invoice_id: inv.id, invoice_number: inv.detail.invoice_number, client,
      ...(before ? { status_before: before } : {}), status_after: inv.status, ...(overdue ? { days_overdue: overdue } : {}), observed_on: today, initial, summary,
    };
  }

  // One poll. The first poll only records a baseline (plus derived overdue events) so startup is quiet.
  poll(): Promise<PaymentEvent[]> {
    if (!this.polling) this.polling = this.doPoll().finally(() => { this.polling = undefined; });
    return this.polling;
  }

  private async doPoll() {
    const initial = this.last.size === 0;
    const invoices = await this.client.searchInvoices();
    const events: PaymentEvent[] = [];
    for (const inv of invoices) {
      const before = this.last.get(inv.id);
      if (!initial && before !== inv.status) events.push(this.make(inv, eventTypeFor(before, inv.status), false, before));
      this.last.set(inv.id, inv.status);
      const overdue = !isPaid(inv) && inv.status !== 'DRAFT' && daysOverdue(inv, this.opts.today()) > 0 && !inv.status.includes('CANCELLED') && !inv.status.includes('REFUNDED');
      if (overdue && !this.overdueSeen.has(inv.id)) { this.overdueSeen.add(inv.id); events.push(this.make(inv, 'TRANCHE.INVOICE.OVERDUE', initial)); }
      if (!overdue) this.overdueSeen.delete(inv.id);
    }
    // An invoice that vanishes from PayPal keeps its last known copy, so the plan (which depends on it) stays computable.
    const seen = new Set(invoices.map((i) => i.id));
    const kept = this.invoices.filter((i) => !seen.has(i.id));
    this.missing = kept.map((i) => i.id);
    this.invoices = [...invoices, ...kept];
    this.history.push(...events);
    this.opts.onEvents?.(events, this.invoices);
    return events;
  }

  start(intervalMs: number) {
    this.stop();
    this.timer = setInterval(() => { this.poll().catch(() => {}); }, intervalMs);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
