import { ASSIGNMENTS, PROJECTS, TEAM } from '../domain/mockData.ts';
import { blockedPhases, computeSchedule, currentPlanDate, daysOverdue, findInvoice, initialPlanDates, previewRelease, previewShift, type BoardContext } from '../domain/schedule.ts';
import { bookingConflicts } from '../domain/capacity.ts';
import { toGanttData, trancheState } from '../domain/gantt.ts';
import type { Assignment, ClientProject, PayPalInvoice, PlanDates, Resource, Schedule, ShiftPreview } from '../domain/types.ts';

export type AppliedChange = { confirmation_id: string; preview_id: string; invoice_number: string; from: string; to: string; applied_at: string };

export const scheduleToObject = (s: Schedule) => Object.fromEntries([...s.entries()].map(([id, d]) => [id, { ...d }]));

// The board's single source of truth on the server: latest PayPal invoices (from the watcher) + owner-approved plan dates.
export class Board {
  readonly projects: ClientProject[] = PROJECTS;
  readonly resources: Resource[] = TEAM;
  readonly assignments: Assignment[] = ASSIGNMENTS;
  invoices: PayPalInvoice[] = [];
  planDates: PlanDates = {};
  readonly applied: AppliedChange[] = [];
  readonly previews = new Map<string, ShiftPreview>();

  readonly today: string;
  constructor(today: string) { this.today = today; }

  setInvoices(invoices: PayPalInvoice[]) {
    // Plan dates are initialised once from the first PayPal snapshot; later status changes never move the plan by themselves.
    const init = initialPlanDates(invoices);
    for (const [num, date] of Object.entries(init)) if (!(num in this.planDates)) this.planDates[num] = date;
    this.invoices = invoices;
  }

  ctx(): BoardContext {
    return { projects: this.projects, invoices: this.invoices, today: this.today, planDates: { ...this.planDates }, resources: this.resources, assignments: this.assignments };
  }

  schedule() { return computeSchedule(this.projects, this.invoices, this.planDates); }

  preview(kind: 'shift' | 'release', input: { invoice_number: string; assumed_payment_date?: string }) {
    const p = kind === 'shift' ? previewShift(input, this.ctx()) : previewRelease(input, this.ctx());
    this.previews.set(p.preview_id, p);
    return p;
  }

  // Recompute a stored preview against the current board (same inputs). Used for staleness checks.
  recompute(previewId: string): ShiftPreview {
    const old = this.previews.get(previewId);
    if (!old) throw new Error(`unknown preview ${previewId}`);
    return old.kind === 'shift'
      ? previewShift({ invoice_number: old.invoice.invoice_number, assumed_payment_date: old.assumption_source === 'model' ? old.assumed_payment_date : undefined }, this.ctx())
      : previewRelease({ invoice_number: old.invoice.invoice_number }, this.ctx());
  }

  apply(p: ShiftPreview, confirmationId: string): AppliedChange {
    const change: AppliedChange = { confirmation_id: confirmationId, preview_id: p.preview_id, invoice_number: p.invoice.invoice_number, from: this.planDates[p.invoice.invoice_number], to: p.assumed_payment_date, applied_at: new Date().toISOString() };
    this.planDates[p.invoice.invoice_number] = p.assumed_payment_date;
    this.applied.push(change);
    return change;
  }

  undo(confirmationId: string): AppliedChange {
    const top = this.applied.at(-1);
    if (!top) throw new Error('Nothing to undo');
    if (top.confirmation_id !== confirmationId) throw new Error(`Only the latest change (${top.confirmation_id}) can be undone`);
    this.applied.pop();
    this.planDates[top.invoice_number] = top.from;
    return top;
  }

  invoiceSummaries(reminders: (invoiceId: string) => number = () => 0) {
    return this.invoices.map((inv) => ({
      invoice_number: inv.detail.invoice_number, invoice_id: inv.id, client: inv.primary_recipients[0]?.billing_info.business_name || '',
      amount: `${inv.amount.value} ${inv.amount.currency_code}`, status: inv.status, state: trancheState(inv, this.today),
      due_date: inv.detail.payment_term.due_date, days_overdue: daysOverdue(inv, this.today), plan_date: currentPlanDate(this.ctx(), inv),
      paid_date: inv.payments?.transactions.at(-1)?.payment_date ?? null, reminders_sent_today: reminders(inv.id),
    }));
  }

  invoice(num: string) { return findInvoice(this.invoices, num); }

  snapshot(reminders?: (invoiceId: string) => number) {
    const schedule = this.schedule();
    return {
      today: this.today,
      invoices: this.invoiceSummaries(reminders),
      plan_dates: { ...this.planDates },
      schedule: scheduleToObject(schedule),
      blocked: blockedPhases(this.ctx()),
      conflicts: bookingConflicts(schedule, this.assignments, this.resources),
      applied: [...this.applied],
      gantt: toGanttData(this.projects, this.invoices, this.today, { planDates: this.planDates, resources: this.resources, assignments: this.assignments }),
    };
  }
}
