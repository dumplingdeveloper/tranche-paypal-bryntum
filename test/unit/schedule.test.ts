import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASSIGNMENTS, DEMO_TODAY, MOCK_INVOICES, PROJECTS, TEAM } from '../../src/domain/mockData.ts';
import { blockedPhases, computeSchedule, initialPlanDates, previewRelease, previewShift, ShiftPreviewError } from '../../src/domain/schedule.ts';
import { bookingConflicts } from '../../src/domain/capacity.ts';
import { toGanttData } from '../../src/domain/gantt.ts';

const ctx = { projects: PROJECTS, invoices: MOCK_INVOICES, today: DEMO_TODAY };

test('base plan chains phases behind tranche milestones', () => {
  const s = computeSchedule(PROJECTS, MOCK_INVOICES);
  assert.deepEqual(s.get('acme-t2'), { start: '2026-10-25', end: '2026-10-25' });
  assert.deepEqual(s.get('acme-build'), { start: '2026-10-25', end: '2026-11-15' });
  assert.deepEqual(s.get('acme-launch'), { start: '2026-11-22', end: '2026-11-27' });
});

test('INV-2 preview moves only Acme dependents and reports 9 days overdue', () => {
  const p = previewShift({ invoice_number: 'INV-2', assumed_payment_date: '2026-11-10' }, ctx);
  assert.equal(p.invoice.days_overdue, 9);
  assert.deepEqual(p.moved.map((m) => [m.task_id, m.new_start, m.delta_days]), [
    ['acme-t2', '2026-11-10', 16], ['acme-build', '2026-11-10', 16], ['acme-t3', '2026-12-01', 9], ['acme-launch', '2026-12-01', 9],
  ]);
  assert.deepEqual(p.unaffected_projects, ['Birch & Pine Studio — Brand refresh']);
  assert.equal(p.client_deadline_slip_days, 9);
});

test('policy default is today + 7 days when the model gives no date', () => {
  const p = previewShift({ invoice_number: 'inv-2' }, ctx);
  assert.equal(p.assumed_payment_date, '2026-11-10');
  assert.equal(p.assumption_source, 'policy_default');
});

test('rejects paid invoices, unknown invoices and past dates', () => {
  assert.throws(() => previewShift({ invoice_number: 'INV-1' }, ctx), (e: unknown) => e instanceof ShiftPreviewError && e.code === 'NOT_SHIFTABLE');
  assert.throws(() => previewShift({ invoice_number: 'INV-9' }, ctx), (e: unknown) => e instanceof ShiftPreviewError && e.code === 'INVOICE_NOT_FOUND');
  assert.throws(() => previewShift({ invoice_number: 'INV-2', assumed_payment_date: '2026-11-01' }, ctx), (e: unknown) => e instanceof ShiftPreviewError && e.code === 'DATE_IN_PAST');
});

test('gantt data marks the phase after an overdue tranche as blocked', () => {
  const { tasks, dependencies } = toGanttData(PROJECTS, MOCK_INVOICES, DEMO_TODAY);
  const build = tasks[0].children!.find((t) => t.id === 'acme-build')!;
  assert.equal(build.blockedBy, 'INV-2');
  assert.equal(dependencies.length, 6 + 4);
  assert.ok(dependencies.every((d) => d.type === 2));
});

test('release preview aligns a paid tranche with its PayPal payment date; NO_CHANGE when already aligned', () => {
  const invoices = structuredClone(MOCK_INVOICES);
  const inv2 = invoices.find((i) => i.detail.invoice_number === 'INV-2')!;
  inv2.status = 'PAID';
  inv2.payments = { paid_amount: inv2.amount, transactions: [{ payment_id: 'T1', payment_date: '2026-11-03', method: 'PAYPAL', type: 'PAYPAL', amount: inv2.amount }] };
  const c = { projects: PROJECTS, invoices, today: DEMO_TODAY, planDates: { ...initialPlanDates(MOCK_INVOICES), 'INV-2': '2026-11-10' } };
  const p = previewRelease({ invoice_number: 'INV-2' }, c);
  assert.equal(p.kind, 'release');
  assert.equal(p.assumption_source, 'paypal_payment_date');
  assert.equal(p.plan_date_before, '2026-11-10');
  assert.equal(p.assumed_payment_date, '2026-11-03');
  assert.deepEqual(p.moved.find((m) => m.task_id === 'acme-build')!.delta_days, -7);
  assert.throws(() => previewRelease({ invoice_number: 'INV-1' }, ctx), (e: unknown) => e instanceof ShiftPreviewError && e.code === 'NO_CHANGE');
  assert.throws(() => previewRelease({ invoice_number: 'INV-2' }, ctx), (e: unknown) => e instanceof ShiftPreviewError && e.code === 'NOT_PAID');
});

test('INV-2 shift preview reports the Dana booking conflict it would create', () => {
  const p = previewShift({ invoice_number: 'INV-2' }, { ...ctx, resources: TEAM, assignments: ASSIGNMENTS });
  assert.deepEqual(p.capacity.new_conflicts.map((c) => [c.resource, c.overlap_start, c.overlap_end]), [['dana', '2026-11-16', '2026-11-23']]);
  assert.deepEqual(bookingConflicts(computeSchedule(PROJECTS, MOCK_INVOICES), ASSIGNMENTS, TEAM), []);
});

test('blocked phases: overdue, refunded and cancelled tranches block the next phase', () => {
  assert.deepEqual(blockedPhases(ctx).map((b) => [b.task_id, b.blocked_by, b.reason]), [['acme-build', 'INV-2', 'overdue']]);
  const invoices = structuredClone(MOCK_INVOICES);
  invoices.find((i) => i.detail.invoice_number === 'INV-4')!.status = 'REFUNDED';
  invoices.find((i) => i.detail.invoice_number === 'INV-2')!.status = 'CANCELLED';
  assert.deepEqual(blockedPhases({ ...ctx, invoices }).map((b) => [b.task_id, b.reason]), [['acme-build', 'cancelled'], ['birch-identity', 'refunded']]);
});

test('Bryntum dates are anchored at local noon (DST-safe)', () => {
  const { tasks } = toGanttData(PROJECTS, MOCK_INVOICES, DEMO_TODAY);
  const all = tasks.flatMap((t) => t.children!);
  for (const t of all) if (t.startDate) assert.match(t.startDate, /^\d{4}-\d{2}-\d{2}T12:00:00$/);
});
