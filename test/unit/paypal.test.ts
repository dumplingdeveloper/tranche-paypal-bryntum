import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockInvoicingClient } from '../../src/paypal/mockInvoicing.ts';
import { InvoicingError } from '../../src/paypal/invoicing.ts';
import { PaymentWatcher, type PaymentEvent } from '../../src/paypal/watcher.ts';

const today = () => '2026-11-03';
const issue = (code: string) => (e: unknown) => e instanceof InvoicingError && e.issue === code;

test('mock reminder follows the spec: only UNPAID/SENT/PARTIALLY_PAID, max 2 per invoice per day', async () => {
  const c = new MockInvoicingClient({ today });
  await c.remindInvoice('INV-2');
  await c.remindInvoice('INV-2');
  await assert.rejects(c.remindInvoice('INV-2'), issue('MOCK_REMINDER_DAILY_LIMIT'));
  assert.equal(c.remindersOn('INV-2'), 2);
  await assert.rejects(c.remindInvoice('INV-1'), issue('CANNOT_REMIND_INVOICE'));
  await assert.rejects(c.remindInvoice('INV-3'), issue('CANNOT_REMIND_INVOICE')); // DRAFT
  await assert.rejects(c.getInvoice('INV-9'), issue('MOCK_RESOURCE_NOT_FOUND'));
});

test('mock payments: payer payment → PAID with a PAYPAL transaction; partial external → PARTIALLY_PAID; refund → REFUNDED', async () => {
  const c = new MockInvoicingClient({ today });
  const { payment_id } = await c.simulatePayerPayment('INV-2', '2026-11-03');
  let inv = await c.getInvoice('INV-2');
  assert.equal(inv.status, 'PAID');
  assert.deepEqual(inv.payments!.transactions.at(-1), { payment_id, payment_date: '2026-11-03', method: 'PAYPAL', type: 'PAYPAL', amount: { currency_code: 'EUR', value: '4800.00' } });
  await assert.rejects(c.recordPayment('INV-2', { payment_date: '2026-11-03', method: 'BANK_TRANSFER' }), issue('CANNOT_PROCESS_PAYMENTS'));

  await c.recordPayment('INV-5', { payment_date: '2026-11-03', method: 'BANK_TRANSFER', amount: { currency_code: 'EUR', value: '1000.00' } });
  inv = await c.getInvoice('INV-5');
  assert.equal(inv.status, 'PARTIALLY_PAID');
  assert.equal(inv.payments!.paid_amount.value, '1000.00');
  await assert.rejects(c.recordPayment('INV-5', { payment_date: '2026-11-03', method: 'BANK_TRANSFER', amount: { currency_code: 'EUR', value: '2500.00' } }), issue('PAYMENT_AMOUNT_GREATER_THAN_AMOUNT_DUE'));

  await c.recordRefund('INV-4', { refund_date: '2026-11-03', method: 'BANK_TRANSFER' });
  assert.equal((await c.getInvoice('INV-4')).status, 'REFUNDED');
  await assert.rejects(c.recordRefund('INV-3', { refund_date: '2026-11-03', method: 'BANK_TRANSFER' }), issue('CANNOT_PROCESS_REFUNDS'));
  assert.deepEqual(c.calls.map((x) => x.op), ['payer_payment', 'record_payment', 'record_refund']);
});

test('mock cancel: drafts and paid invoices cannot be cancelled', async () => {
  const c = new MockInvoicingClient({ today });
  await assert.rejects(c.cancelInvoice('INV-3'), issue('CANNOT_CANCEL_DRAFT_INVOICE'));
  await assert.rejects(c.cancelInvoice('INV-1'), issue('CANNOT_CANCEL_PAID_INVOICE'));
  await c.cancelInvoice('INV-5');
  assert.equal((await c.getInvoice('INV-5')).status, 'CANCELLED');
  await assert.rejects(c.cancelInvoice('INV-5'), issue('INVOICE_CANCELED_ALREADY'));
});

test('watcher: first poll is a baseline (+ derived overdue), later polls emit webhook-shaped events', async () => {
  const c = new MockInvoicingClient({ today });
  const seen: PaymentEvent[][] = [];
  const w = new PaymentWatcher(c, { today, onEvents: (e) => seen.push(e) });
  const first = await w.poll();
  assert.deepEqual(first.map((e) => [e.event_type, e.invoice_number, e.source, e.initial, e.days_overdue]), [['TRANCHE.INVOICE.OVERDUE', 'INV-2', 'tranche-clock', true, 9]]);
  assert.deepEqual(await w.poll(), []);
  await c.simulatePayerPayment('INV-2');
  await c.recordRefund('INV-4', { refund_date: '2026-11-03', method: 'BANK_TRANSFER' });
  await c.cancelInvoice('INV-5');
  const [a, b] = await Promise.all([w.poll(), w.poll()]); // single-flight
  assert.equal(a, b);
  assert.deepEqual(a.map((e) => [e.event_type, e.invoice_number, e.status_before, e.status_after, e.source]), [
    ['INVOICING.INVOICE.PAID', 'INV-2', 'SENT', 'PAID', 'mock-poll'],
    ['INVOICING.INVOICE.REFUNDED', 'INV-4', 'PAID', 'REFUNDED', 'mock-poll'],
    ['INVOICING.INVOICE.CANCELLED', 'INV-5', 'SENT', 'CANCELLED', 'mock-poll'],
  ]);
  assert.equal(seen.length, 3);
  assert.equal(w.history.length, 4);
});
