import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board } from '../../src/server/board.ts';
import { DEMO_TODAY, MOCK_INVOICES } from '../../src/domain/mockData.ts';

test('board lists invoices INV-1 → INV-n whatever order PayPal search returns (real sandbox returns newest first)', () => {
  const board = new Board(DEMO_TODAY);
  board.setInvoices([...MOCK_INVOICES].reverse());
  assert.deepEqual(board.snapshot().invoices.map((i) => i.invoice_number), ['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-5']);
  // Numeric, not lexical: INV-10 comes after INV-9 and INV-2.
  const extra = (n: string, id: string) => ({ ...MOCK_INVOICES[0], id, detail: { ...MOCK_INVOICES[0].detail, invoice_number: n } });
  board.setInvoices([extra('INV-10', 'X10'), MOCK_INVOICES[1], extra('INV-9', 'X9'), MOCK_INVOICES[0]]);
  assert.deepEqual(board.invoices.map((i) => i.detail.invoice_number), ['INV-1', 'INV-2', 'INV-9', 'INV-10']);
  // A later poll in another order keeps the same order and does not touch the plan dates set by the first snapshot.
  const plan = { ...board.planDates };
  board.setInvoices([...board.invoices].reverse());
  assert.deepEqual(board.invoices.map((i) => i.detail.invoice_number), ['INV-1', 'INV-2', 'INV-9', 'INV-10']);
  assert.deepEqual(board.planDates, plan);
});
