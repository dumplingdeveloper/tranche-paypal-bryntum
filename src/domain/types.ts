// Invoice shape follows PayPal Invoicing v2 (subset). See docs/FACTS_PAYPAL_INVOICING.md for spec citations.
export type InvoiceStatus =
  | 'DRAFT' | 'SENT' | 'SCHEDULED' | 'PAID' | 'MARKED_AS_PAID' | 'CANCELLED' | 'REFUNDED'
  | 'PARTIALLY_PAID' | 'PARTIALLY_REFUNDED' | 'MARKED_AS_REFUNDED' | 'UNPAID' | 'PAYMENT_PENDING'
  | 'AUTO_CANCELLED' | 'PAID_EXTERNAL' | 'REFUNDED_EXTERNAL' | 'SHARED';

export type Money = { currency_code: string; value: string };

export type PayPalInvoice = {
  id: string;
  status: InvoiceStatus;
  detail: {
    invoice_number: string;
    currency_code: string;
    invoice_date: string;
    note?: string;
    payment_term: { term_type: string; due_date: string };
  };
  primary_recipients: Array<{ billing_info: { business_name: string; email_address: string } }>;
  amount: Money;
  payments?: { paid_amount: Money; transactions: Array<{ payment_date: string; method: string; type: 'PAYPAL' | 'EXTERNAL' }> };
};

export type Phase = { kind: 'phase'; id: string; name: string; durationDays: number; startNoEarlierThan?: string };
export type Tranche = { kind: 'tranche'; id: string; invoiceNumber: string; label: string };
export type Step = Phase | Tranche;

export type ClientProject = { id: string; client: string; name: string; steps: Step[] };

export type TaskDates = { start: string; end: string };
export type Schedule = Map<string, TaskDates>;

export type ShiftPreviewInput = { invoice_number: string; assumed_payment_date?: string };

export type MovedTask = {
  task_id: string;
  project: string;
  name: string;
  kind: 'phase' | 'tranche';
  old_start: string;
  old_end: string;
  new_start: string;
  new_end: string;
  delta_days: number;
};

export type ShiftPreview = {
  preview_id: string;
  today: string;
  invoice: { invoice_number: string; client: string; status: InvoiceStatus; amount: string; due_date: string; days_overdue: number };
  assumed_payment_date: string;
  assumption_source: 'model' | 'policy_default';
  moved: MovedTask[];
  unaffected_projects: string[];
  client_deadline_slip_days: number;
};
