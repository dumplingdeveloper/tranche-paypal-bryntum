import type { ClientProject, MovedTask, PayPalInvoice, Schedule, ShiftPreview, ShiftPreviewInput, Step } from './types.ts';

const DAY = 86_400_000;
const PAID_STATUSES = new Set(['PAID', 'MARKED_AS_PAID', 'PAID_EXTERNAL']);
// Statuses where money is still expected, so a tranche milestone can slip.
const SHIFTABLE_STATUSES = new Set(['DRAFT', 'SENT', 'SCHEDULED', 'UNPAID', 'PARTIALLY_PAID', 'PAYMENT_PENDING', 'SHARED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'MARKED_AS_REFUNDED', 'REFUNDED_EXTERNAL']);
export const DEFAULT_GRACE_DAYS = 7;

export const toMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
export const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (date: string, days: number) => fromMs(toMs(date) + days * DAY);
export const diffDays = (a: string, b: string) => Math.round((toMs(a) - toMs(b)) / DAY);
const maxDate = (a: string, b: string) => (a >= b ? a : b);
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(toMs(s));

export class ShiftPreviewError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export function findInvoice(invoices: PayPalInvoice[], invoiceNumber: string) {
  const wanted = invoiceNumber.trim().toUpperCase();
  return invoices.find((inv) => inv.detail.invoice_number.toUpperCase() === wanted || inv.id.toUpperCase() === wanted);
}

export function isPaid(inv: PayPalInvoice) { return PAID_STATUSES.has(inv.status); }

export function daysOverdue(inv: PayPalInvoice, today: string) {
  if (isPaid(inv)) return 0;
  return Math.max(0, diffDays(today, inv.detail.payment_term.due_date));
}

// When the plan assumes the tranche money lands: actual payment date if paid, otherwise the due date.
export function plannedTrancheDate(inv: PayPalInvoice) {
  const paid = inv.payments?.transactions.at(-1)?.payment_date;
  return isPaid(inv) && paid ? paid : inv.detail.payment_term.due_date;
}

// Forward pass over finish-to-start chains (calendar days, 24/7 project calendar, same as the Gantt project config).
export function computeSchedule(projects: ClientProject[], invoices: PayPalInvoice[], trancheOverrides: Record<string, string> = {}): Schedule {
  const schedule: Schedule = new Map();
  for (const project of projects) {
    let cursor = '';
    for (const step of project.steps) {
      if (step.kind === 'phase') {
        const start = cursor ? maxDate(cursor, step.startNoEarlierThan || cursor) : (step.startNoEarlierThan || '');
        if (!start) throw new Error(`First phase ${step.id} needs startNoEarlierThan`);
        const end = addDays(start, step.durationDays);
        schedule.set(step.id, { start, end });
        cursor = end;
      } else {
        const inv = findInvoice(invoices, step.invoiceNumber);
        if (!inv) throw new Error(`Unknown invoice ${step.invoiceNumber}`);
        const paymentDate = trancheOverrides[inv.detail.invoice_number] || plannedTrancheDate(inv);
        const date = maxDate(cursor, paymentDate);
        schedule.set(step.id, { start: date, end: date });
        cursor = date;
      }
    }
  }
  return schedule;
}

export function projectOfStep(projects: ClientProject[], stepId: string) {
  return projects.find((p) => p.steps.some((s) => s.id === stepId));
}

export function stepName(step: Step) { return step.kind === 'phase' ? step.name : `${step.label} · ${step.invoiceNumber}`; }

export function previewShift(input: ShiftPreviewInput, ctx: { projects: ClientProject[]; invoices: PayPalInvoice[]; today: string }): ShiftPreview {
  const inv = findInvoice(ctx.invoices, String(input.invoice_number || ''));
  if (!inv) throw new ShiftPreviewError('INVOICE_NOT_FOUND', `No invoice ${input.invoice_number}. Known: ${ctx.invoices.map((i) => i.detail.invoice_number).join(', ')}`);
  if (!SHIFTABLE_STATUSES.has(inv.status)) throw new ShiftPreviewError('NOT_SHIFTABLE', `Invoice ${inv.detail.invoice_number} is ${inv.status}; nothing to shift.`);
  let assumed = addDays(ctx.today, DEFAULT_GRACE_DAYS);
  let source: ShiftPreview['assumption_source'] = 'policy_default';
  if (input.assumed_payment_date !== undefined && input.assumed_payment_date !== null && input.assumed_payment_date !== '') {
    if (!isDate(input.assumed_payment_date)) throw new ShiftPreviewError('BAD_DATE', 'assumed_payment_date must be YYYY-MM-DD');
    if (input.assumed_payment_date < ctx.today) throw new ShiftPreviewError('DATE_IN_PAST', `assumed_payment_date must be on or after today (${ctx.today})`);
    assumed = input.assumed_payment_date;
    source = 'model';
  }
  const before = computeSchedule(ctx.projects, ctx.invoices);
  const after = computeSchedule(ctx.projects, ctx.invoices, { [inv.detail.invoice_number]: assumed });
  const moved: MovedTask[] = [];
  const touched = new Set<string>();
  for (const project of ctx.projects) {
    for (const step of project.steps) {
      const a = before.get(step.id)!; const b = after.get(step.id)!;
      if (a.start === b.start && a.end === b.end) continue;
      touched.add(project.id);
      moved.push({ task_id: step.id, project: `${project.client} — ${project.name}`, name: stepName(step), kind: step.kind, old_start: a.start, old_end: a.end, new_start: b.start, new_end: b.end, delta_days: diffDays(b.start, a.start) });
    }
  }
  const owner = ctx.projects.find((p) => p.steps.some((s) => s.kind === 'tranche' && s.invoiceNumber === inv.detail.invoice_number));
  const last = owner?.steps.at(-1);
  const slip = last ? diffDays(after.get(last.id)!.end, before.get(last.id)!.end) : 0;
  return {
    preview_id: `pv_${inv.detail.invoice_number}_${assumed}`,
    today: ctx.today,
    invoice: { invoice_number: inv.detail.invoice_number, client: inv.primary_recipients[0]?.billing_info.business_name || '', status: inv.status, amount: `${inv.amount.value} ${inv.amount.currency_code}`, due_date: inv.detail.payment_term.due_date, days_overdue: daysOverdue(inv, ctx.today) },
    assumed_payment_date: assumed,
    assumption_source: source,
    moved,
    unaffected_projects: ctx.projects.filter((p) => !touched.has(p.id)).map((p) => `${p.client} — ${p.name}`),
    client_deadline_slip_days: slip,
  };
}
