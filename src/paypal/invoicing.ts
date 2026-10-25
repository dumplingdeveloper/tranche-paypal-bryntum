// PayPal Invoicing v2 surface Tranche needs. Endpoint references are to
// paypal-rest-api-specifications/openapi/invoicing_v2.json (see docs/FACTS_PAYPAL_INVOICING.md).
// Implemented by MockInvoicingClient (default) and SandboxInvoicingClient (sandboxClient.ts, TRANCHE_PAYPAL=sandbox).
import type { InvoiceStatus, Money, PayPalInvoice } from '../domain/types.ts';

// `notification` body of send/remind/cancel (INV:6291). PayPal ignores a user subject/note (INV:6298, :6305),
// so Tranche never sends them.
export type InvoiceNotification = { send_to_recipient?: boolean; send_to_invoicer?: boolean };

// `payment_detail` (INV:6341); method enum `payment_method` (INV:6394). `refund_detail` (INV:6682).
export type PaymentMethod = 'BANK_TRANSFER' | 'CASH' | 'CHECK' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'PAYPAL' | 'WIRE_TRANSFER' | 'OTHER';
export type PaymentDetail = { payment_date: string; method: PaymentMethod; amount?: Money; note?: string };
export type RefundDetail = { refund_date: string; method: PaymentMethod; amount?: Money };

export type InvoiceSearch = { status?: InvoiceStatus[] };

export type InvoicingCall = { op: string; invoice_id: string; at: string; detail?: unknown };

export interface InvoicingClient {
  readonly mode: 'mock' | 'sandbox';
  /** Calls made by this process (no secrets), shown in the UI and audit. */
  readonly calls: InvoicingCall[];
  /** Reminders this process sent for the invoice on the given day (PayPal allows 2 per day, INV:480). */
  remindersOn(invoiceId: string, day?: string): number;
  /** POST /v2/invoicing/search-invoices (INV:1767); status filter INV:6802. */
  searchInvoices(query?: InvoiceSearch): Promise<PayPalInvoice[]>;
  /** GET /v2/invoicing/invoices/{invoice_id} (INV:1440). */
  getInvoice(invoiceId: string): Promise<PayPalInvoice>;
  /** POST /v2/invoicing/invoices/{invoice_id}/send (INV:337). */
  sendInvoice(invoiceId: string, notification?: InvoiceNotification): Promise<void>;
  /** POST /v2/invoicing/invoices/{invoice_id}/remind (INV:477) — "only 2 reminders in a day" (INV:480). */
  remindInvoice(invoiceId: string, notification?: InvoiceNotification): Promise<void>;
  /** POST /v2/invoicing/invoices/{invoice_id}/cancel (INV:632). */
  cancelInvoice(invoiceId: string, notification?: InvoiceNotification): Promise<void>;
  /** POST /v2/invoicing/invoices/{invoice_id}/payments (INV:742) — external payment, no payer browser needed. */
  recordPayment(invoiceId: string, payment: PaymentDetail): Promise<{ payment_id: string }>;
  /** POST /v2/invoicing/invoices/{invoice_id}/refunds (INV:1005). */
  recordRefund(invoiceId: string, refund: RefundDetail): Promise<{ refund_id: string }>;
}

// Error shaped like PayPal's (HTTP status + details[].issue). `issue` values come from the spec where one exists
// (e.g. CANNOT_REMIND_INVOICE, INV:5309); values starting with MOCK_ are ours and say so.
export class InvoicingError extends Error {
  status: number;
  issue: string;
  constructor(status: number, issue: string, message: string) {
    super(message);
    this.status = status;
    this.issue = issue;
  }
}
