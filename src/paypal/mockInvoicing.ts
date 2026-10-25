// Deterministic in-memory stand-in for PayPal Invoicing v2. Status transitions follow the spec text:
// payments → PAID / PARTIALLY_PAID (INV:745), refunds → REFUNDED / PARTIALLY_REFUNDED (INV:1008).
// Everything here is labelled MOCK in the UI and in the audit log.
import { MOCK_INVOICES } from '../domain/mockData.ts';
import type { InvoiceStatus, Money, PayPalInvoice } from '../domain/types.ts';
import { InvoicingError, type InvoicingCall, type InvoiceNotification, type InvoiceSearch, type InvoicingClient, type PaymentDetail, type RefundDetail } from './invoicing.ts';

const REMINDABLE = new Set<InvoiceStatus>(['UNPAID', 'SENT', 'PARTIALLY_PAID']); // INV:5309-5318
const REMINDERS_PER_DAY = 2; // INV:480
const cents = (m: Money) => Math.round(Number(m.value) * 100);
const money = (c: number, currency: string): Money => ({ currency_code: currency, value: (c / 100).toFixed(2) });

export type MockCall = InvoicingCall;

export class MockInvoicingClient implements InvoicingClient {
  readonly mode = 'mock' as const;
  private invoices: PayPalInvoice[];
  private seq = 0;
  readonly calls: MockCall[] = [];
  private readonly today: () => string;

  constructor(opts: { today: () => string; seed?: PayPalInvoice[] }) {
    this.today = opts.today;
    this.invoices = structuredClone(opts.seed || MOCK_INVOICES);
  }

  private find(id: string) {
    const inv = this.invoices.find((i) => i.id === id || i.detail.invoice_number === id);
    if (!inv) throw new InvoicingError(404, 'MOCK_RESOURCE_NOT_FOUND', `Invoice ${id} not found (mock)`);
    return inv;
  }

  private log(op: string, inv: PayPalInvoice, detail?: unknown) {
    this.calls.push({ op, invoice_id: inv.id, at: this.today(), ...(detail === undefined ? {} : { detail }) });
  }

  remindersOn(invoiceId: string, day = this.today()) {
    const inv = this.find(invoiceId);
    return this.calls.filter((c) => c.op === 'remind' && c.invoice_id === inv.id && c.at === day).length;
  }

  async searchInvoices(query: InvoiceSearch = {}) {
    const list = query.status?.length ? this.invoices.filter((i) => query.status!.includes(i.status)) : this.invoices;
    return structuredClone(list);
  }

  async getInvoice(invoiceId: string) { return structuredClone(this.find(invoiceId)); }

  async sendInvoice(invoiceId: string, notification?: InvoiceNotification) {
    const inv = this.find(invoiceId);
    if (inv.status !== 'DRAFT' && inv.status !== 'SCHEDULED') throw new InvoiceStateError(inv, 'send');
    inv.status = 'SENT';
    this.log('send', inv, notification);
  }

  async remindInvoice(invoiceId: string, notification?: InvoiceNotification) {
    const inv = this.find(invoiceId);
    if (!REMINDABLE.has(inv.status)) {
      throw new InvoicingError(422, 'CANNOT_REMIND_INVOICE', `You cannot remind an invoice which is in ${inv.status} status. Only UNPAID, SENT and PARTIALLY_PAID invoices can be reminded.`);
    }
    if (this.remindersOn(inv.id) >= REMINDERS_PER_DAY) {
      throw new InvoicingError(422, 'MOCK_REMINDER_DAILY_LIMIT', `Mock enforces the documented limit: only ${REMINDERS_PER_DAY} reminders per invoice per day (INV:480).`);
    }
    this.log('remind', inv, notification);
  }

  async cancelInvoice(invoiceId: string, notification?: InvoiceNotification) {
    const inv = this.find(invoiceId);
    if (inv.status === 'DRAFT') throw new InvoicingError(422, 'CANNOT_CANCEL_DRAFT_INVOICE', 'Draft invoices cannot be cancelled (mock).');
    if (inv.status === 'PAID' || inv.status === 'MARKED_AS_PAID') throw new InvoicingError(422, 'CANNOT_CANCEL_PAID_INVOICE', 'Paid invoices cannot be cancelled (mock).');
    if (inv.status === 'CANCELLED') throw new InvoicingError(422, 'INVOICE_CANCELED_ALREADY', 'Invoice is already cancelled (mock).');
    inv.status = 'CANCELLED';
    this.log('cancel', inv, notification);
  }

  async recordPayment(invoiceId: string, payment: PaymentDetail) {
    return this.addPayment(invoiceId, payment, 'EXTERNAL');
  }

  // Mock-only demo control: what a buyer paying the PayPal-hosted invoice page would cause. In the real sandbox this
  // needs a sandbox personal account in a browser, so it is never part of InvoicingClient.
  async simulatePayerPayment(invoiceId: string, paymentDate = this.today()) {
    return this.addPayment(invoiceId, { payment_date: paymentDate, method: 'PAYPAL' }, 'PAYPAL');
  }

  private addPayment(invoiceId: string, payment: PaymentDetail, type: 'PAYPAL' | 'EXTERNAL') {
    const inv = this.find(invoiceId);
    if (!['SENT', 'UNPAID', 'PARTIALLY_PAID', 'SCHEDULED'].includes(inv.status)) throw new InvoicingError(422, 'CANNOT_PROCESS_PAYMENTS', `Invoice in ${inv.status} status cannot take payments (mock).`);
    const total = cents(inv.amount);
    const paid = inv.payments ? cents(inv.payments.paid_amount) : 0;
    const due = total - paid;
    const amount = payment.amount ? cents(payment.amount) : due;
    if (amount <= 0) throw new InvoicingError(422, 'VALUE_CANNOT_BE_ZERO', 'Payment amount must be positive (mock).');
    if (amount > due) throw new InvoicingError(422, 'PAYMENT_AMOUNT_GREATER_THAN_AMOUNT_DUE', 'Payment amount is greater than the amount due (mock).');
    const payment_id = `MOCKTX-${String(++this.seq).padStart(4, '0')}`;
    inv.payments = inv.payments || { paid_amount: money(0, inv.amount.currency_code), transactions: [] };
    inv.payments.transactions.push({ payment_id, payment_date: payment.payment_date, method: payment.method, type, amount: money(amount, inv.amount.currency_code), ...(payment.note ? { note: payment.note } : {}) });
    inv.payments.paid_amount = money(paid + amount, inv.amount.currency_code);
    inv.status = paid + amount >= total ? 'PAID' : 'PARTIALLY_PAID';
    this.log(type === 'PAYPAL' ? 'payer_payment' : 'record_payment', inv, { payment_id, amount: amount / 100, method: payment.method });
    return { payment_id };
  }

  async recordRefund(invoiceId: string, refund: RefundDetail) {
    const inv = this.find(invoiceId);
    const paid = inv.payments ? cents(inv.payments.paid_amount) : 0;
    if (!paid) throw new InvoicingError(422, 'CANNOT_PROCESS_REFUNDS', `Invoice ${inv.detail.invoice_number} has no payments to refund (mock).`);
    const already = inv.refunds ? cents(inv.refunds.refund_amount) : 0;
    const amount = refund.amount ? cents(refund.amount) : paid - already;
    if (amount <= 0 || already + amount > paid) throw new InvoicingError(422, 'INVALID_REFUND_AMOUNT', 'Refund amount exceeds the paid amount (mock).');
    const refund_id = `MOCKRF-${String(++this.seq).padStart(4, '0')}`;
    inv.refunds = inv.refunds || { refund_amount: money(0, inv.amount.currency_code), transactions: [] };
    inv.refunds.transactions.push({ refund_id, refund_date: refund.refund_date, method: refund.method, type: 'EXTERNAL', amount: money(amount, inv.amount.currency_code) });
    inv.refunds.refund_amount = money(already + amount, inv.amount.currency_code);
    inv.status = already + amount >= paid ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    this.log('record_refund', inv, { refund_id, amount: amount / 100 });
    return { refund_id };
  }
}

class InvoiceStateError extends InvoicingError {
  constructor(inv: PayPalInvoice, op: string) {
    super(422, 'MOCK_INVALID_STATUS', `Cannot ${op} invoice ${inv.detail.invoice_number} in ${inv.status} status (mock).`);
  }
}
