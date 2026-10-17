import type { ClientProject, PayPalInvoice } from './types.ts';

// Deterministic demo clock so screenshots, tests and the video never drift.
export const DEMO_TODAY = '2026-11-03';

const recipient = (business_name: string, email_address: string) => [{ billing_info: { business_name, email_address } }];
const eur = (value: string) => ({ currency_code: 'EUR', value });

export const MOCK_INVOICES: PayPalInvoice[] = [
  {
    id: 'INV2-ACME-0001', status: 'PAID', amount: eur('3600.00'),
    detail: { invoice_number: 'INV-1', currency_code: 'EUR', invoice_date: '2026-09-28', payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: '2026-10-05' } },
    primary_recipients: recipient('Acme Coffee Roasters', 'accounts@acme-coffee.example'),
    payments: { paid_amount: eur('3600.00'), transactions: [{ payment_date: '2026-10-04', method: 'PAYPAL', type: 'PAYPAL' }] },
  },
  {
    id: 'INV2-ACME-0002', status: 'SENT', amount: eur('4800.00'),
    detail: { invoice_number: 'INV-2', currency_code: 'EUR', invoice_date: '2026-10-11', payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: '2026-10-25' } },
    primary_recipients: recipient('Acme Coffee Roasters', 'accounts@acme-coffee.example'),
  },
  {
    id: 'INV2-ACME-0003', status: 'DRAFT', amount: eur('3600.00'),
    detail: { invoice_number: 'INV-3', currency_code: 'EUR', invoice_date: '2026-11-08', payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: '2026-11-22' } },
    primary_recipients: recipient('Acme Coffee Roasters', 'accounts@acme-coffee.example'),
  },
  {
    id: 'INV2-BIRCH-0004', status: 'PAID', amount: eur('3000.00'),
    detail: { invoice_number: 'INV-4', currency_code: 'EUR', invoice_date: '2026-10-12', payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: '2026-10-22' } },
    primary_recipients: recipient('Birch & Pine Studio', 'hello@birchpine.example'),
    payments: { paid_amount: eur('3000.00'), transactions: [{ payment_date: '2026-10-20', method: 'PAYPAL', type: 'PAYPAL' }] },
  },
  {
    id: 'INV2-BIRCH-0005', status: 'SENT', amount: eur('3000.00'),
    detail: { invoice_number: 'INV-5', currency_code: 'EUR', invoice_date: '2026-10-29', payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: '2026-11-12' } },
    primary_recipients: recipient('Birch & Pine Studio', 'hello@birchpine.example'),
  },
];

export const PROJECTS: ClientProject[] = [
  {
    id: 'acme', client: 'Acme Coffee Roasters', name: 'Online shop rebuild',
    steps: [
      { kind: 'phase', id: 'acme-discovery', name: 'Discovery & sitemap', durationDays: 7, startNoEarlierThan: '2026-09-28' },
      { kind: 'tranche', id: 'acme-t1', invoiceNumber: 'INV-1', label: 'Tranche 1 (30%)' },
      { kind: 'phase', id: 'acme-design', name: 'Design system & mockups', durationDays: 14 },
      { kind: 'tranche', id: 'acme-t2', invoiceNumber: 'INV-2', label: 'Tranche 2 (40%)' },
      { kind: 'phase', id: 'acme-build', name: 'Build & integrations', durationDays: 21 },
      { kind: 'tranche', id: 'acme-t3', invoiceNumber: 'INV-3', label: 'Tranche 3 (30%)' },
      { kind: 'phase', id: 'acme-launch', name: 'Launch & handover', durationDays: 5 },
    ],
  },
  {
    id: 'birch', client: 'Birch & Pine Studio', name: 'Brand refresh',
    steps: [
      { kind: 'phase', id: 'birch-audit', name: 'Brand audit', durationDays: 10, startNoEarlierThan: '2026-10-12' },
      { kind: 'tranche', id: 'birch-t1', invoiceNumber: 'INV-4', label: 'Tranche 1 (50%)' },
      { kind: 'phase', id: 'birch-identity', name: 'Identity design', durationDays: 14 },
      { kind: 'tranche', id: 'birch-t2', invoiceNumber: 'INV-5', label: 'Tranche 2 (50%)' },
      { kind: 'phase', id: 'birch-rollout', name: 'Rollout & templates', durationDays: 7 },
    ],
  },
];
