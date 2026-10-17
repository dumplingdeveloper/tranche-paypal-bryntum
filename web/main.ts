import { DateHelper, Gantt, TaskModel } from '@bryntum/gantt';
import { DEMO_TODAY, MOCK_INVOICES, PROJECTS } from '../src/domain/mockData.ts';
import { computeSchedule, previewShift } from '../src/domain/schedule.ts';
import { toGanttData, trancheState } from '../src/domain/gantt.ts';

class TrancheTask extends TaskModel {
  static get fields() {
    return ['kind', 'invoiceNumber', 'invoiceStatus', 'trancheState', 'amount', 'dueDate', 'daysOverdue', 'blockedBy'];
  }
}

type TrancheRecord = TrancheTask & { kind?: string; invoiceNumber?: string; invoiceStatus?: string; trancheState?: string; amount?: string; daysOverdue?: number; blockedBy?: string };
const rec = (r: unknown) => r as TrancheRecord;

const params = new URLSearchParams(location.search);
const previewInvoice = params.get('preview');
const assumed = params.get('assumed') || undefined;
const today = params.get('today') || DEMO_TODAY;
const fmt = (d: Date) => DateHelper.format(d, 'YYYY-MM-DD');
const pretty = (s: string) => DateHelper.format(DateHelper.parse(s, 'YYYY-MM-DD'), 'D MMM');

document.getElementById('clock')!.textContent = `Demo clock: ${pretty(today)} 2026`;
document.getElementById('invoices')!.innerHTML = MOCK_INVOICES.map((inv) => {
  const state = trancheState(inv, today);
  const overdue = state === 'overdue' ? ` · <b>${Math.round((Date.parse(today) - Date.parse(inv.detail.payment_term.due_date)) / 86400000)}d overdue</b>` : '';
  return `<div class="inv ${state}"><b>${inv.detail.invoice_number}</b> ${inv.primary_recipients[0].billing_info.business_name} · €${Number(inv.amount.value).toLocaleString('en-IE')} · ${inv.status} · due ${pretty(inv.detail.payment_term.due_date)}${overdue}</div>`;
}).join('');

const baseSchedule = computeSchedule(PROJECTS, MOCK_INVOICES);
const preview = previewInvoice ? previewShift({ invoice_number: previewInvoice, assumed_payment_date: assumed }, { projects: PROJECTS, invoices: MOCK_INVOICES, today }) : null;
const data = toGanttData(PROJECTS, MOCK_INVOICES, today, preview ? { baseline: baseSchedule } : {});

const gantt = new Gantt({
  appendTo: 'gantt',
  startDate: '2026-09-21',
  endDate: '2026-12-21',
  viewPreset: 'weekAndDayLetter',
  tickSize: 13,
  rowHeight: 42,
  barMargin: 9,
  columns: [
    { type: 'name', width: 250 },
    {
      text: 'PayPal tranche', width: 150, field: 'trancheState',
      renderer: ({ record: r }: { record: unknown }) => {
        const record = rec(r);
        if (record.kind === 'tranche') return { tag: 'span', className: `state-chip ${record.trancheState}`, text: `${record.invoiceStatus}${record.daysOverdue ? ` +${record.daysOverdue}d` : ''}` };
        return record.blockedBy ? { tag: 'span', className: 'state-chip overdue', text: `blocked by ${record.blockedBy}` } : '';
      },
    },
    { type: 'startdate', width: 82, format: 'D MMM' },
    { type: 'enddate', width: 82, format: 'D MMM' },
  ],
  features: {
    baselines: Boolean(preview),
    timeRanges: { showCurrentTimeLine: false },
    labels: { right: { field: 'amount', renderer: ({ taskRecord: t }) => { const taskRecord = rec(t); return taskRecord.kind === 'tranche' ? `${taskRecord.invoiceNumber} ${taskRecord.amount}` : ''; } } },
  },
  taskRenderer: ({ taskRecord: t, renderData: rd }) => {
    const taskRecord = rec(t);
    const renderData = rd as unknown as { cls: Record<string, boolean> };
    if (taskRecord.kind === 'tranche') renderData.cls[`tranche-${taskRecord.trancheState}`] = true;
    if (taskRecord.kind === 'phase' && taskRecord.blockedBy && !preview) renderData.cls['phase-blocked'] = true;
    return '';
  },
  project: {
    taskModelClass: TrancheTask,
    tasks: data.tasks,
    dependencies: data.dependencies,
    timeRanges: [{ id: 'today', name: `Today ${pretty(today)}`, startDate: today, duration: 0, durationUnit: 'day' }],
  },
});

async function engineCheck(expected: ReturnType<typeof computeSchedule>) {
  await gantt.project.commitAsync();
  const mismatches: string[] = [];
  for (const [id, want] of expected) {
    const task = gantt.taskStore.getById(id) as TrancheTask;
    const got = { start: fmt(task.startDate as Date), end: fmt(task.endDate as Date) };
    if (got.start !== want.start || got.end !== want.end) mismatches.push(`${id}: engine ${got.start}..${got.end} vs ours ${want.start}..${want.end}`);
  }
  return { checked: expected.size, mismatches };
}

async function run() {
  await gantt.project.commitAsync();
  const result: Record<string, unknown> = { today, mode: preview ? 'preview' : 'plan' };
  result.planCheck = await engineCheck(baseSchedule);
  const banner = document.getElementById('banner')!;
  if (preview) {
    // Programmatic move: re-constrain the tranche milestone to the assumed payment date; the Bryntum engine propagates to dependents.
    for (const task of gantt.taskStore.query((r) => rec(r).kind === 'tranche' && rec(r).invoiceNumber === preview.invoice.invoice_number) as TrancheTask[]) {
      await task.setConstraint('startnoearlierthan', DateHelper.parse(preview.assumed_payment_date, 'YYYY-MM-DD'));
    }
    const check = await engineCheck(computeSchedule(PROJECTS, MOCK_INVOICES, { [preview.invoice.invoice_number]: preview.assumed_payment_date }));
    result.previewCheck = check;
    result.preview = preview;
    banner.hidden = false;
    banner.className = check.mismatches.length ? 'banner' : 'banner ok';
    banner.innerHTML = `<b>PREVIEW (not applied)</b> · ${preview.invoice.invoice_number} ${preview.invoice.client} is ${preview.invoice.days_overdue}d overdue · assume paid ${pretty(preview.assumed_payment_date)} → ${preview.moved.length} items move, client launch slips <b>${preview.client_deadline_slip_days}d</b>. Ghost bars = current plan. Engine check: ${check.checked - check.mismatches.length}/${check.checked} dates match our preview.`;
  } else {
    banner.hidden = false;
    const blocked = gantt.taskStore.query((r) => Boolean(rec(r).blockedBy)).length;
    const check = result.planCheck as { checked: number; mismatches: string[] };
    banner.innerHTML = `<b>Current plan</b> · ${blocked} phase(s) blocked by an overdue tranche. Engine check: ${check.checked - check.mismatches.length}/${check.checked} dates match our scheduler.`;
  }
  (window as unknown as { __tranche: unknown }).__tranche = { ready: true, ...result };
}

run().catch((err) => { (window as unknown as { __tranche: unknown }).__tranche = { ready: true, error: String(err?.stack || err) }; });
