import type { Assignment, ClientProject, PayPalInvoice, PlanDates, Resource, Schedule } from './types.ts';
import { computeSchedule, daysOverdue, findInvoice, isPaid, plannedTrancheDate, trancheBlockReason } from './schedule.ts';

export type TrancheState = 'paid' | 'overdue' | 'awaiting' | 'draft' | 'refunded' | 'cancelled';

export function trancheState(inv: PayPalInvoice, today: string): TrancheState {
  if (isPaid(inv)) return 'paid';
  const reason = trancheBlockReason(inv, today);
  if (reason) return reason;
  if (inv.status === 'DRAFT') return 'draft';
  return 'awaiting';
}

// Bryntum's 24/7 calendar adds durations in elapsed hours of the *browser's* time zone, so a 21-day task that
// crosses a DST change would end at 23:00 the day before. Anchoring every date at local noon keeps the calendar
// day identical to our UTC-day scheduler in every time zone (checked by test/e2e in several zones).
export const ANCHOR_TIME = 'T12:00:00';
export const toBryntumDate = (day: string) => `${day}${ANCHOR_TIME}`;

export type GanttTaskData = {
  id: string;
  name: string;
  expanded?: boolean;
  startDate?: string;
  duration?: number;
  durationUnit?: 'day';
  constraintType?: 'startnoearlierthan' | null;
  constraintDate?: string | null;
  children?: GanttTaskData[];
  kind: 'project' | 'phase' | 'tranche';
  invoiceNumber?: string;
  invoiceStatus?: string;
  trancheState?: TrancheState;
  amount?: string;
  dueDate?: string;
  daysOverdue?: number;
  blockedBy?: string;
  blockReason?: string;
  manuallyScheduled?: boolean;
};

export type GanttDependencyData = { id: string; fromTask: string; toTask: string; type: 2 };

// Converts the payment-aware plan into Bryntum Gantt inline data (tasks + finish-to-start dependencies + team).
export function toGanttData(projects: ClientProject[], invoices: PayPalInvoice[], today: string, opts: { planDates?: PlanDates; resources?: Resource[]; assignments?: Assignment[] } = {}) {
  const tasks: GanttTaskData[] = [];
  const dependencies: GanttDependencyData[] = [];
  for (const project of projects) {
    const children: GanttTaskData[] = [];
    let prev: string | undefined;
    let pending: { inv: string; reason: string } | undefined;
    for (const step of project.steps) {
      if (step.kind === 'phase') {
        children.push({
          id: step.id, name: step.name, kind: 'phase', duration: step.durationDays, durationUnit: 'day',
          ...(step.startNoEarlierThan ? { startDate: toBryntumDate(step.startNoEarlierThan), constraintType: 'startnoearlierthan' as const, constraintDate: toBryntumDate(step.startNoEarlierThan) } : {}),
          ...(pending ? { blockedBy: pending.inv, blockReason: pending.reason } : {}),
        });
        pending = undefined;
      } else {
        const inv = findInvoice(invoices, step.invoiceNumber)!;
        const state = trancheState(inv, today);
        const date = opts.planDates?.[inv.detail.invoice_number] ?? plannedTrancheDate(inv);
        children.push({
          id: step.id, name: `${step.label} · ${inv.detail.invoice_number}`, kind: 'tranche', startDate: toBryntumDate(date), duration: 0, durationUnit: 'day',
          constraintType: 'startnoearlierthan', constraintDate: toBryntumDate(date),
          invoiceNumber: inv.detail.invoice_number, invoiceStatus: inv.status, trancheState: state,
          amount: `€${Number(inv.amount.value).toLocaleString('en-IE')}`, dueDate: inv.detail.payment_term.due_date, daysOverdue: daysOverdue(inv, today),
        });
        const reason = trancheBlockReason(inv, today);
        if (reason) pending = { inv: inv.detail.invoice_number, reason };
      }
      if (prev) dependencies.push({ id: `${prev}->${step.id}`, fromTask: prev, toTask: step.id, type: 2 });
      prev = step.id;
    }
    tasks.push({ id: project.id, name: `${project.client} — ${project.name}`, kind: 'project', expanded: true, children });
  }
  return {
    tasks,
    dependencies,
    resources: (opts.resources || []).map((r) => ({ id: r.id, name: r.name, role: r.role })),
    assignments: (opts.assignments || []).map((a) => ({ id: a.id, event: a.event, resource: a.resource })),
  };
}

export function expectedSchedule(projects: ClientProject[], invoices: PayPalInvoice[], planDates: PlanDates = {}): Schedule {
  return computeSchedule(projects, invoices, planDates);
}
