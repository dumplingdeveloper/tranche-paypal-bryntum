// Deterministic fallback used when no LLM is configured. It calls the SAME tools as the real agent, but its
// decisions are hard-coded rules, so every message and audit entry is labelled "scripted" and it is never
// counted as evidence of the real agent.
import { runTool, type ToolCallRecord, type ToolHost } from './tools.ts';
import type { AgentEvent, AgentInfo, AgentRunner, AgentTurn } from './runner.ts';

export const SCRIPTED_LABEL = 'Scripted agent (no LLM)';

type InvoiceRow = { invoice_number: string; client: string; status: string; state: string; plan_date: string; paid_date: string | null; days_overdue: number };

export class ScriptedAgent implements AgentRunner {
  info: AgentInfo;
  private host: ToolHost;
  constructor(host: ToolHost, reason = 'TRANCHE_AGENT=scripted') {
    this.host = host;
    this.info = { mode: 'scripted', label: SCRIPTED_LABEL, live: false, reason };
  }

  async ask(prompt: string, opts: { turnId: string; trigger: AgentTurn['trigger']; onEvent: (e: AgentEvent) => void }): Promise<AgentTurn> {
    const started = Date.now();
    const calls: ToolCallRecord[] = [];
    const meta = { agent: 'scripted' };
    const call = (tool: string, args: Record<string, unknown>) => {
      opts.onEvent({ type: 'tool_start', tool, args });
      const out = runTool(tool, args, this.host, meta, calls);
      opts.onEvent({ type: 'tool_done', record: calls.at(-1)! });
      return out as Record<string, any>;
    };
    opts.onEvent({ type: 'status', status: 'thinking' });
    const lines: string[] = [];
    const status = call('get_board_status', {});
    const invoices = status.invoices as InvoiceRow[];
    const named = /INV-\d+/i.exec(prompt)?.[0]?.toUpperCase();
    const target = (named && invoices.find((i) => i.invoice_number === named))
      || invoices.find((i) => ['overdue', 'refunded', 'cancelled'].includes(i.state))
      || invoices.find((i) => i.state === 'paid' && i.paid_date && i.paid_date !== i.plan_date && i.paid_date >= status.today);
    if (!target) lines.push('Nothing on the board needs attention right now.');
    else if (target.state === 'paid') {
      const r = call('schedule_release_preview', { invoice_number: target.invoice_number });
      if (r.ok) {
        const p = r.preview;
        const req = call('request_schedule_change', { preview_id: p.preview_id, note_to_owner: `${target.invoice_number} was paid on ${p.assumed_payment_date}.` });
        lines.push(`${target.invoice_number} (${target.client}) is paid on ${p.assumed_payment_date}. Aligning the plan moves ${p.moved.length} items; delivery changes by ${p.client_deadline_slip_days} days.`);
        if (req.ok) lines.push(`Approval card ${req.confirmation_id} is waiting for you.`);
      } else lines.push(`No change proposed for ${target.invoice_number}: ${r.error.message}`);
    } else {
      const r = call('schedule_shift_preview', { invoice_number: target.invoice_number, reason: `${target.state}${target.days_overdue ? ` ${target.days_overdue} days` : ''}` });
      if (r.ok) {
        const p = r.preview;
        const req = call('request_schedule_change', { preview_id: p.preview_id, note_to_owner: `Assumes ${target.invoice_number} is paid by ${p.assumed_payment_date} (policy default).` });
        const conflicts = p.capacity.new_conflicts.map((c: any) => `${c.resource_name} double-booked ${c.overlap_start}–${c.overlap_end}`).join('; ');
        lines.push(`${target.invoice_number} (${target.client}) is ${target.state}${target.days_overdue ? ` by ${target.days_overdue} days` : ''}. If it is paid ${p.assumed_payment_date}, ${p.moved.length} items move and delivery slips ${p.client_deadline_slip_days} days.${conflicts ? ` Warning: ${conflicts}.` : ''}`);
        if (req.ok) lines.push(`Approval card ${req.confirmation_id} is waiting for you.`);
      } else lines.push(`No shift proposed for ${target.invoice_number}: ${r.error.message}`);
      const facts = call('get_reminder_facts', { invoice_number: target.invoice_number });
      if (facts.ok && facts.can_remind_now) {
        const note = `Hi ${facts.client} team, a quick nudge on invoice ${facts.invoice_number} (${facts.amount}), due ${facts.due_date}. We're ready to start the next phase as soon as it's settled. Thanks!`;
        const rem = call('request_payment_reminder', { invoice_number: target.invoice_number, friendly_note: note });
        if (rem.ok) lines.push(`Reminder card ${rem.confirmation_id} drafted.`);
      }
    }
    const text = `[${SCRIPTED_LABEL}] ${lines.join(' ')}`;
    opts.onEvent({ type: 'message', text });
    opts.onEvent({ type: 'status', status: 'idle' });
    return { turn_id: opts.turnId, mode: 'scripted', live: false, trigger: opts.trigger, prompt, text, tool_calls: calls, duration_ms: Date.now() - started, ok: true };
  }

  async stop() {}
}
