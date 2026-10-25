// Agent tools. Every tool is read-only with respect to the board and PayPal: the request_* tools only create a
// *pending* confirmation (bound to preview_id / payload hash) that the owner must approve in the UI.
// The same specs back the Copilot SDK agent (via defineTool) and the scripted fallback agent.
import { ShiftPreviewError, daysOverdue } from '../domain/schedule.ts';
import type { InvoiceStatus, ShiftPreview } from '../domain/types.ts';
import type { Board } from '../server/board.ts';
import { hashPayload, type ConfirmationBroker } from '../server/broker.ts';
import type { AuditLog } from '../server/audit.ts';
import type { InvoiceNotification } from '../paypal/invoicing.ts';

export type ToolHost = {
  board: Board;
  broker: ConfirmationBroker;
  audit: AuditLog;
  reminders: (invoiceId: string) => number;
  previewShown: (p: ShiftPreview) => void;
  applySchedule: (p: ShiftPreview, confirmationId: string) => Promise<unknown> | unknown;
  sendReminder: (invoiceId: string, notification: InvoiceNotification) => Promise<unknown>;
};

export type ToolMeta = { agent: string };
type JsonSchema = Record<string, unknown>;
export type ToolSpec = { name: string; description: string; parameters: JsonSchema; handler: (args: Record<string, unknown>, host: ToolHost, meta: ToolMeta) => Record<string, unknown> };

export class ToolError extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code; } }

const REMINDABLE = new Set<InvoiceStatus>(['UNPAID', 'SENT', 'PARTIALLY_PAID']); // INV:5309-5318
export const REMINDER_LIMIT_PER_DAY = 2; // INV:480
const PAYPAL_NOTE_POLICY = 'PayPal sends its own standard reminder e-mail: a custom subject or note is not honoured by the Invoicing API (notification.subject/note). Your friendly note is shown to the owner to copy into their own e-mail.';

function requireInvoice(host: ToolHost, num: unknown) {
  const inv = host.board.invoice(String(num || ''));
  if (!inv) throw new ToolError('INVOICE_NOT_FOUND', `No invoice ${num}. Known: ${host.board.invoices.map((i) => i.detail.invoice_number).join(', ')}`);
  return inv;
}

function reminderPayload(host: ToolHost, invoiceNumber: string, note: string) {
  const inv = requireInvoice(host, invoiceNumber);
  if (!REMINDABLE.has(inv.status)) throw new ToolError('CANNOT_REMIND_INVOICE', `${inv.detail.invoice_number} is ${inv.status}; PayPal only reminds UNPAID, SENT and PARTIALLY_PAID invoices.`);
  const sent = host.reminders(inv.id);
  if (sent >= REMINDER_LIMIT_PER_DAY) throw new ToolError('REMINDER_LIMIT_REACHED', `${sent} reminders already sent today for ${inv.detail.invoice_number}; PayPal allows ${REMINDER_LIMIT_PER_DAY} per day.`);
  return {
    invoice_id: inv.id, invoice_number: inv.detail.invoice_number, status: inv.status, client: inv.primary_recipients[0]?.billing_info.business_name || '',
    notification: { send_to_recipient: true, send_to_invoicer: false } as InvoiceNotification,
    friendly_note: note,
  };
}

const fmtPreview = (p: ShiftPreview) => {
  const moves = p.moved.filter((m) => m.kind === 'phase').map((m) => `${m.name} ${m.delta_days >= 0 ? '+' : ''}${m.delta_days}d`).join(', ');
  const verb = p.kind === 'release' ? `align ${p.invoice.invoice_number} with its PayPal payment on ${p.assumed_payment_date}` : `assume ${p.invoice.invoice_number} is paid ${p.assumed_payment_date}`;
  return `Apply schedule: ${verb} → ${moves || 'milestone only'}; ${p.invoice.client} delivery ${p.client_deadline_slip_days >= 0 ? 'slips' : 'gains'} ${Math.abs(p.client_deadline_slip_days)}d.`;
};

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'get_board_status',
    description: 'Read the delivery board: PayPal invoice tranches (status, due date, days overdue, plan date), blocked phases, team booking conflicts and pending owner confirmations. Read-only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: (_args, host) => {
      const snap = host.board.snapshot(host.reminders);
      return {
        today: snap.today,
        invoices: snap.invoices,
        blocked_phases: snap.blocked,
        booking_conflicts: snap.conflicts,
        plan: Object.fromEntries(host.board.projects.map((p) => [`${p.client} — ${p.name}`, p.steps.map((s) => ({ task_id: s.id, kind: s.kind, ...snap.schedule[s.id] }))])),
        pending_confirmations: host.broker.list().filter((c) => c.status === 'pending').map((c) => ({ id: c.id, kind: c.kind, invoice_number: c.invoice_number, summary: c.summary })),
      };
    },
  },
  {
    name: 'schedule_shift_preview',
    description: 'Preview (never apply) how an UNPAID tranche (late, refunded or cancelled PayPal invoice) shifts the dependent phases if the money lands on an assumed date. Returns moved tasks with old/new dates, client delivery slip and team booking conflicts, all computed by the scheduler. Returns a preview_id.',
    parameters: {
      type: 'object',
      properties: {
        invoice_number: { type: 'string', description: 'PayPal invoice number of the tranche, e.g. "INV-2".' },
        assumed_payment_date: { type: 'string', description: 'YYYY-MM-DD date you assume the payment will arrive (today or later). Omit to use the policy default of today + 7 days.' },
        reason: { type: 'string', description: 'Short reason, e.g. "overdue 9 days".' },
      },
      required: ['invoice_number'],
      additionalProperties: false,
    },
    handler: (args, host) => {
      const p = host.board.preview('shift', { invoice_number: String(args.invoice_number || ''), assumed_payment_date: args.assumed_payment_date as string | undefined });
      host.previewShown(p);
      return { applied: false, preview: p };
    },
  },
  {
    name: 'schedule_release_preview',
    description: 'Preview (never apply) aligning the plan with a PAID tranche: the milestone moves to the actual PayPal payment date and dependent phases follow (earlier or later). Returns a preview_id.',
    parameters: {
      type: 'object',
      properties: { invoice_number: { type: 'string', description: 'PayPal invoice number of the paid tranche, e.g. "INV-2".' } },
      required: ['invoice_number'],
      additionalProperties: false,
    },
    handler: (args, host) => {
      const p = host.board.preview('release', { invoice_number: String(args.invoice_number || '') });
      host.previewShown(p);
      return { applied: false, preview: p };
    },
  },
  {
    name: 'request_schedule_change',
    description: 'Ask the owner to approve a schedule preview. Creates a pending confirmation card bound to preview_id; nothing changes until the owner clicks Apply. Fails if the preview is stale.',
    parameters: {
      type: 'object',
      properties: {
        preview_id: { type: 'string', description: 'preview_id returned by schedule_shift_preview or schedule_release_preview.' },
        note_to_owner: { type: 'string', description: 'One short sentence for the owner explaining why.' },
      },
      required: ['preview_id'],
      additionalProperties: false,
    },
    handler: (args, host, meta) => {
      const id = String(args.preview_id || '');
      const p = host.board.previews.get(id);
      if (!p) throw new ToolError('UNKNOWN_PREVIEW', `No preview ${id}; call a preview tool first.`);
      const fresh = host.board.recompute(id);
      if (hashPayload(fresh) !== hashPayload(p)) throw new ToolError('PREVIEW_STALE', `The board changed since ${id}; call the preview tool again.`);
      if (!p.moved.length) throw new ToolError('NOTHING_TO_APPLY', 'This preview moves nothing.');
      const c = host.broker.create({
        kind: 'apply_schedule', invoice_number: p.invoice.invoice_number, preview_id: id, payload: p, requested_by: meta.agent,
        summary: fmtPreview(p) + (args.note_to_owner ? ` Agent note: ${String(args.note_to_owner).slice(0, 240)}` : ''),
        recheck: () => host.board.recompute(id),
        execute: (payload, conf) => host.applySchedule(payload as ShiftPreview, conf.id),
      });
      return { confirmation_id: c.id, status: 'pending_owner_approval', payload_hash: c.payload_hash, summary: c.summary };
    },
  },
  {
    name: 'get_reminder_facts',
    description: 'Facts for drafting a friendly payment reminder: client, amount, due date, days overdue, the phase it blocks, reminders already sent today and the PayPal limit. Read-only.',
    parameters: { type: 'object', properties: { invoice_number: { type: 'string' } }, required: ['invoice_number'], additionalProperties: false },
    handler: (args, host) => {
      const inv = requireInvoice(host, args.invoice_number);
      const blocked = host.board.snapshot().blocked.find((b) => b.blocked_by === inv.detail.invoice_number);
      const sent = host.reminders(inv.id);
      return {
        invoice_number: inv.detail.invoice_number, client: inv.primary_recipients[0]?.billing_info.business_name, contact: inv.primary_recipients[0]?.billing_info.email_address,
        amount: `${inv.amount.value} ${inv.amount.currency_code}`, status: inv.status, due_date: inv.detail.payment_term.due_date, days_overdue: daysOverdue(inv, host.board.today),
        blocks_phase: blocked ? `${blocked.name} (${blocked.project})` : null,
        reminders_sent_today: sent, reminder_limit_per_day: REMINDER_LIMIT_PER_DAY, can_remind_now: REMINDABLE.has(inv.status) && sent < REMINDER_LIMIT_PER_DAY,
        paypal_note_policy: PAYPAL_NOTE_POLICY,
      };
    },
  },
  {
    name: 'request_payment_reminder',
    description: 'Ask the owner to approve sending the PayPal invoice reminder. Creates a pending confirmation; on approval PayPal sends its standard reminder and your friendly_note is shown to the owner to copy into their own e-mail.',
    parameters: {
      type: 'object',
      properties: {
        invoice_number: { type: 'string' },
        friendly_note: { type: 'string', description: 'A short, warm note (max ~80 words) the owner can paste into an e-mail to the client.' },
      },
      required: ['invoice_number', 'friendly_note'],
      additionalProperties: false,
    },
    handler: (args, host, meta) => {
      const note = String(args.friendly_note || '').trim().slice(0, 1200);
      if (!note) throw new ToolError('EMPTY_NOTE', 'friendly_note is required.');
      const payload = reminderPayload(host, String(args.invoice_number || ''), note);
      const c = host.broker.create({
        kind: 'send_reminder', invoice_number: payload.invoice_number, payload, requested_by: meta.agent,
        summary: `Send PayPal reminder for ${payload.invoice_number} (${payload.client}, ${payload.status}). PayPal uses its standard text; copy the friendly note into your own e-mail.`,
        recheck: () => reminderPayload(host, payload.invoice_number, note),
        execute: (p) => host.sendReminder((p as typeof payload).invoice_id, (p as typeof payload).notification),
      });
      return { confirmation_id: c.id, status: 'pending_owner_approval', payload_hash: c.payload_hash, summary: c.summary };
    },
  },
];

export const TOOL_NAMES = TOOL_SPECS.map((t) => t.name);

export type ToolCallRecord = { tool: string; args: Record<string, unknown>; ok: boolean; error?: { code: string; message: string }; agent: string };

// Runs one tool with error capture + audit. Returns the JSON object handed back to the model.
export function runTool(name: string, args: Record<string, unknown>, host: ToolHost, meta: ToolMeta, log?: ToolCallRecord[]) {
  const spec = TOOL_SPECS.find((t) => t.name === name);
  const rec: ToolCallRecord = { tool: name, args: structuredClone(args ?? {}), ok: false, agent: meta.agent };
  let out: Record<string, unknown>;
  try {
    if (!spec) throw new ToolError('UNKNOWN_TOOL', `No tool ${name}`);
    out = { ok: true, ...spec.handler(args ?? {}, host, meta) };
    rec.ok = true;
  } catch (err) {
    const e = err as Error & { code?: string };
    rec.error = { code: e instanceof ToolError || e instanceof ShiftPreviewError ? (e as ToolError).code : 'INTERNAL', message: e.message };
    out = { ok: false, error: rec.error };
  }
  log?.push(rec);
  host.audit.append('agent', 'agent.tool_call', { tool: name, args: rec.args, ok: rec.ok, ...(rec.error ? { error: rec.error } : {}), agent: meta.agent });
  return out;
}
