import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_TODAY, MOCK_INVOICES, PROJECTS } from '../src/domain/mockData.ts';
import { computeSchedule, previewShift, ShiftPreviewError } from '../src/domain/schedule.ts';
import { toGanttData } from '../src/domain/gantt.ts';

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
