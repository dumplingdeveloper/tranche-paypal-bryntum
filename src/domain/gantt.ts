import type { ClientProject, PayPalInvoice, Schedule } from './types.ts';
import { computeSchedule, daysOverdue, findInvoice, isPaid, plannedTrancheDate } from './schedule.ts';

export type TrancheState = 'paid' | 'overdue' | 'awaiting' | 'draft' | 'refunded';

export function trancheState(inv: PayPalInvoice, today: string): TrancheState {
  if (isPaid(inv)) return 'paid';
  if (inv.status.includes('REFUNDED')) return 'refunded';
  if (inv.status === 'DRAFT') return 'draft';
  return daysOverdue(inv, today) > 0 ? 'overdue' : 'awaiting';
}

export type GanttTaskData = {
  id: string;
  name: string;
  expanded?: boolean;
  startDate?: string;
  duration?: number;
  durationUnit?: 'day';
  constraintType?: 'startnoearlierthan' | null;
  constraintDate?: string | null;
  baselines?: Array<{ startDate: string; endDate: string }>;
  children?: GanttTaskData[];
  kind: 'project' | 'phase' | 'tranche';
  invoiceNumber?: string;
  invoiceStatus?: string;
  trancheState?: TrancheState;
  amount?: string;
  dueDate?: string;
  daysOverdue?: number;
  blockedBy?: string;
};

export type GanttDependencyData = { id: string; fromTask: string; toTask: string; type: 2 };

// Converts the payment-aware plan into Bryntum Gantt inline data (tasks + finish-to-start dependencies).
export function toGanttData(projects: ClientProject[], invoices: PayPalInvoice[], today: string, opts: { baseline?: Schedule } = {}) {
  const tasks: GanttTaskData[] = [];
  const dependencies: GanttDependencyData[] = [];
  for (const project of projects) {
    const children: GanttTaskData[] = [];
    let prev: string | undefined;
    let pendingBlocker: string | undefined;
    for (const step of project.steps) {
      const base = opts.baseline?.get(step.id);
      const baselines = base ? [{ startDate: base.start, endDate: base.end }] : undefined;
      if (step.kind === 'phase') {
        children.push({
          id: step.id, name: step.name, kind: 'phase', duration: step.durationDays, durationUnit: 'day',
          ...(step.startNoEarlierThan ? { startDate: step.startNoEarlierThan, constraintType: 'startnoearlierthan' as const, constraintDate: step.startNoEarlierThan } : {}),
          ...(pendingBlocker ? { blockedBy: pendingBlocker } : {}),
          ...(baselines ? { baselines } : {}),
        });
        pendingBlocker = undefined;
      } else {
        const inv = findInvoice(invoices, step.invoiceNumber)!;
        const state = trancheState(inv, today);
        const date = plannedTrancheDate(inv);
        children.push({
          id: step.id, name: `${step.label} · ${inv.detail.invoice_number}`, kind: 'tranche', startDate: date, duration: 0, durationUnit: 'day',
          constraintType: 'startnoearlierthan', constraintDate: date,
          invoiceNumber: inv.detail.invoice_number, invoiceStatus: inv.status, trancheState: state,
          amount: `€${Number(inv.amount.value).toLocaleString('en-IE')}`, dueDate: inv.detail.payment_term.due_date, daysOverdue: daysOverdue(inv, today),
          ...(baselines ? { baselines } : {}),
        });
        if (state === 'overdue' || state === 'refunded') pendingBlocker = inv.detail.invoice_number;
      }
      if (prev) dependencies.push({ id: `${prev}->${step.id}`, fromTask: prev, toTask: step.id, type: 2 });
      prev = step.id;
    }
    tasks.push({ id: project.id, name: `${project.client} — ${project.name}`, kind: 'project', expanded: true, children });
  }
  return { tasks, dependencies };
}

export function expectedSchedule(projects: ClientProject[], invoices: PayPalInvoice[], overrides: Record<string, string> = {}) {
  return computeSchedule(projects, invoices, overrides);
}
