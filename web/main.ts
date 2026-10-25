// Tranche browser app. The server owns the plan (PayPal invoices + owner-approved plan dates); this page renders it
// with Bryntum Gantt + SchedulerPro, applies approved changes through the Gantt's own engine inside an STM
// transaction, undoes them with STM, and reports the engine's dates back to the server for verification.
import { DateHelper, Gantt, SchedulerPro, StringHelper, TaskModel } from '@bryntum/gantt';
import { toBryntumDate } from '../src/domain/gantt.ts';
import type { GanttTaskData } from '../src/domain/gantt.ts';
import type { ShiftPreview } from '../src/domain/types.ts';

type Conf = { id: string; kind: string; status: string; invoice_number: string; preview_id?: string; payload: any; payload_hash: string; summary: string; requested_by: string; resolution?: string };
type ToolRec = { tool: string; args: Record<string, unknown>; ok: boolean; error?: { code: string; message: string } };
type Msg = { id: string; role: 'owner' | 'agent' | 'event'; text: string; mode?: string; live?: boolean; tool_calls?: ToolRec[] };
type State = {
  today: string;
  invoices: Array<{ invoice_number: string; client: string; amount: string; status: string; state: string; due_date: string; days_overdue: number; plan_date: string; paid_date: string | null }>;
  schedule: Record<string, { start: string; end: string }>;
  conflicts: Array<{ resource: string; resource_name: string; task_a: string; task_b: string; overlap_start: string; overlap_end: string }>;
  applied: Array<{ confirmation_id: string }>;
  gantt: { tasks: GanttTaskData[]; dependencies: unknown[]; resources: unknown[]; assignments: unknown[] };
  modes: { paypal: string; agent: { mode: string; label: string; live: boolean; model?: string; reason?: string } };
  confirmations: Conf[];
  audit: Array<{ seq: number; at: string; actor: string; action: string; details: Record<string, unknown> }>;
  events: Array<{ id: string; event_type: string; source: string; summary: string; initial: boolean }>;
  transcript: Msg[];
  agent_busy: boolean;
  last_preview: ShiftPreview | null;
};

const CUSTOM_FIELDS = ['kind', 'invoiceNumber', 'invoiceStatus', 'trancheState', 'amount', 'dueDate', 'daysOverdue', 'blockedBy', 'blockReason', 'conflict', 'conflictWith'] as const;
class TrancheTask extends TaskModel {
  static get fields() { return [...CUSTOM_FIELDS]; }
}
type TR = TrancheTask & Record<(typeof CUSTOM_FIELDS)[number], any>;
const rec = (r: unknown) => r as TR;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (d: Date) => DateHelper.format(d, 'YYYY-MM-DD');
const pretty = (s: string) => DateHelper.format(DateHelper.parse(s, 'YYYY-MM-DD'), 'D MMM');
const el = (tag: string, cls = '', text = '') => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

const post = async (path: string, body: unknown) => {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(json?.error?.message || `HTTP ${r.status}`), { code: json?.error?.code, status: r.status });
  return json;
};

function toast(text: string) {
  const t = $('toast'); t.textContent = text; t.hidden = false;
  clearTimeout((toast as any).timer); (toast as any).timer = setTimeout(() => { t.hidden = true; }, 5000);
}

// --- state shared with tests -------------------------------------------------------------------------------
const reports: Array<{ reason: string; confirmation_id?: string; result: unknown }> = [];
const T: Record<string, unknown> = { ready: false, reports };
(window as any).__tranche = T;

let state: State;
let ghost: ShiftPreview | null = null;
// All Gantt mutations go through one queue so status refreshes never land inside an STM transaction.
let chain: Promise<unknown> = Promise.resolve();
const serial = <R>(fn: () => Promise<R>) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };

const initial: State = await (await fetch('/api/state')).json();
state = initial;
const startDate = '2026-09-14'; // a Monday (weekStartDay 1)
const endDate = '2026-12-14';

const gantt = new Gantt({
  appendTo: 'gantt',
  startDate, endDate,
  weekStartDay: 1,
  // Two header rows that are always readable at 1920px: month, then the Monday of each week.
  viewPreset: { base: 'weekAndMonth', tickWidth: 62, headers: [{ unit: 'month', dateFormat: 'MMMM YYYY' }, { unit: 'week', dateFormat: 'D MMM' }] },
  rowHeight: 32,
  barMargin: 7,
  readOnly: true, // the plan only changes through approved confirmations
  columns: [
    { type: 'name', width: 340 },
    {
      text: 'PayPal tranche', width: 124, field: 'trancheState', sortable: false,
      renderer: ({ record: r }: { record: unknown }) => {
        const t = rec(r);
        if (t.kind === 'tranche') return { tag: 'span', className: `state-chip ${t.trancheState}`, text: `${t.invoiceStatus}${t.daysOverdue ? ` +${t.daysOverdue}d` : ''}` };
        return t.blockedBy ? { tag: 'span', className: 'state-chip overdue', text: `blocked: ${t.blockedBy}` } : '';
      },
    },
    { type: 'startdate', text: 'Start', width: 90, format: 'D MMM' },
    { type: 'enddate', text: 'End', width: 90, format: 'D MMM' },
  ],
  features: {
    baselines: {
      disabled: true,
      renderer: ({ taskRecord, renderData }: { taskRecord: unknown; renderData: any }) => {
        const moved = ghost?.moved.find((m) => m.task_id === (taskRecord as TR).id);
        const milestone = Boolean(moved && moved.new_start === moved.new_end);
        renderData.className = { ...(renderData.className || {}), 'ghost-preview': Boolean(moved), 'ghost-milestone': milestone, 'ghost-hidden': !moved };
        // A moved tranche milestone's label travels with its ghost so the two never overlap.
        const r = rec(taskRecord);
        return milestone && r.kind === 'tranche' ? { tag: 'span', className: 'ghost-label', text: `${r.invoiceNumber} → ${pretty(moved!.new_start)}` } : '';
      },
    },
    projectLines: false,
    timeRanges: { showCurrentTimeLine: false, showHeaderElements: false },
    taskTooltip: {
      template: ({ taskRecord: t }: { taskRecord: unknown }) => {
        const r = rec(t);
        const lines = [`<b>${StringHelper.encodeHtml(r.name)}</b>`, `${fmt(r.startDate as Date)} → ${fmt(r.endDate as Date)}`];
        if (r.kind === 'tranche') lines.push(`PayPal ${StringHelper.encodeHtml(r.invoiceNumber)} · ${StringHelper.encodeHtml(r.amount)} · ${StringHelper.encodeHtml(r.invoiceStatus)} · due ${StringHelper.encodeHtml(r.dueDate)}`);
        if (r.blockedBy) lines.push(`Blocked: ${StringHelper.encodeHtml(r.blockedBy)} is ${StringHelper.encodeHtml(r.blockReason)}`);
        return lines.join('<br>');
      },
    },
    labels: { right: { field: 'amount', renderer: ({ taskRecord: t }: { taskRecord: unknown }) => { const r = rec(t); return r.kind === 'tranche' ? `${r.invoiceNumber} ${r.amount}` : ''; } } },
  },
  taskRenderer: ({ taskRecord: t, renderData: rd }: { taskRecord: unknown; renderData: any }) => {
    const r = rec(t);
    if (r.kind === 'tranche') rd.cls[`tranche-${r.trancheState}`] = true;
    if (r.kind === 'tranche') rd.cls['ghost-moving'] = Boolean(ghost?.moved.some((m) => m.task_id === r.id));
    if (r.kind === 'phase' && r.blockedBy) rd.cls['phase-blocked'] = true;
    return '';
  },
  project: {
    taskModelClass: TrancheTask,
    tasks: withBaselines(initial.gantt.tasks),
    dependencies: initial.gantt.dependencies,
    resources: initial.gantt.resources,
    assignments: initial.gantt.assignments,
    timeRanges: [{ id: 'today', name: `Today ${pretty(initial.today)}`, startDate: toBryntumDate(initial.today), duration: 0, durationUnit: 'day' }],
    stm: { autoRecord: false },
  },
} as any);

const scheduler = new SchedulerPro({
  appendTo: 'capacity',
  project: gantt.project,
  partner: gantt,
  readOnly: true,
  rowHeight: 46,
  barMargin: 8,
  hideHeaders: true,
  eventStyle: 'rounded',
  columns: [{ text: 'Team', field: 'name', width: 644, renderer: ({ record }: { record: any }) => `${record.name} · ${record.role}` }],
  features: { dependencies: false, eventTooltip: { template: ({ eventRecord: e }: { eventRecord: any }) => `<b>${StringHelper.encodeHtml(e.name)}</b><br>${fmt(e.startDate)} → ${fmt(e.endDate)}${e.conflict ? `<br>Double-booked: ${StringHelper.encodeHtml(e.conflict)}` : ''}` } },
  eventRenderer: ({ eventRecord, resourceRecord, renderData }: { eventRecord: any; resourceRecord: any; renderData: any }) => {
    // Outline only the person who is double-booked, not every assignee of the task.
    if (eventRecord.conflictWith && String(eventRecord.conflictWith).split(',').includes(resourceRecord.id)) renderData.cls['booking-conflict'] = true;
    renderData.eventColor = eventRecord.blockedBy ? 'red' : eventRecord.id.startsWith('acme') ? 'blue' : 'teal';
    // Bookings are as narrow as 5 days (~45px), so show the first word; the tooltip has the full name and dates.
    return StringHelper.encodeHtml(String(eventRecord.name).split(/\s+/)[0]);
  },
} as any);

const stm = (gantt.project as any).stm;
stm.enable();

function withBaselines(tasks: GanttTaskData[]): any[] {
  // One baseline per task, only shown (as a dashed "ghost") for tasks a pending preview would move.
  return tasks.map((t) => ({ ...t, ...(t.children ? { children: withBaselines(t.children) } : { baselines: [{ startDate: t.startDate, endDate: t.startDate }] }) }));
}

function engineDates() {
  const out: Record<string, { start: string; end: string }> = {};
  gantt.taskStore.forEach((t: any) => { if (t.kind !== 'project') out[t.id] = { start: fmt(t.startDate), end: fmt(t.endDate) }; });
  return out;
}

function stmInfo() { return { position: stm.position, queue: [...stm.queue], canUndo: stm.canUndo, isRecording: stm.isRecording }; }

async function report(reason: string, confirmation_id?: string) {
  await gantt.project.commitAsync();
  const result = await post('/api/schedule/engine-report', { reason, confirmation_id, engine: engineDates(), stm: stmInfo() });
  reports.push({ reason, confirmation_id, result });
  $('engine-note').textContent = result.mismatches.length ? `engine check FAILED (${result.mismatches.length})` : `Bryntum engine ✓ ${result.matched}/${result.checked} dates match`;
  return result;
}

// Non-scheduling fields (PayPal status, blocked flag, booking conflicts) are refreshed outside any STM transaction.
function refreshTaskFields(s: State) {
  const conflictOf = new Map<string, string[]>();
  const conflictWith = new Map<string, string[]>();
  for (const c of s.conflicts) {
    for (const t of [c.task_a, c.task_b]) {
      conflictOf.set(t, [...(conflictOf.get(t) || []), `${c.resource_name} ${pretty(c.overlap_start)}–${pretty(c.overlap_end)}`]);
      conflictWith.set(t, [...(conflictWith.get(t) || []), c.resource]);
    }
  }
  const walk = (tasks: GanttTaskData[]) => {
    for (const t of tasks) {
      const r = gantt.taskStore.getById(t.id) as TR | undefined;
      if (r) {
        const want: Record<string, unknown> = {};
        for (const f of CUSTOM_FIELDS) if (f !== 'conflict' && f !== 'conflictWith') want[f] = (t as any)[f] ?? null;
        want.conflict = conflictOf.get(t.id)?.join('; ') ?? null;
        want.conflictWith = conflictWith.get(t.id)?.join(',') ?? null;
        const changed = Object.entries(want).filter(([k, v]) => (r as any)[k] !== v && !((r as any)[k] == null && v == null));
        if (changed.length) r.set(Object.fromEntries(changed));
      }
      if (t.children) walk(t.children);
    }
  };
  walk(s.gantt.tasks);
}

function showGhost(p: ShiftPreview | null) {
  ghost = p;
  const banner = $('banner');
  if (!p) { (gantt.features as any).baselines.disabled = true; gantt.refreshRows(); banner.hidden = true; return; }
  for (const m of p.moved) {
    const t = gantt.taskStore.getById(m.task_id) as any;
    const b = t?.baselines?.first;
    b?.set({ startDate: new Date(toBryntumDate(m.new_start)), endDate: new Date(toBryntumDate(m.new_end)) });
  }
  (gantt.features as any).baselines.disabled = false;
  gantt.refreshRows();
  const moves = p.moved.filter((m) => m.kind === 'phase').map((m) => `${m.name} ${m.delta_days >= 0 ? '+' : ''}${m.delta_days}d`).join(', ');
  const conflicts = p.capacity.new_conflicts.map((c) => `${c.resource_name} double-booked ${pretty(c.overlap_start)}–${pretty(c.overlap_end)}`).join('; ');
  const resolved = p.capacity.resolved_conflicts.map((c) => `${c.resource_name} conflict resolved`).join('; ');
  banner.hidden = false;
  banner.replaceChildren();
  banner.append(el('b', '', 'PREVIEW — not applied. '), document.createTextNode(
    `${p.kind === 'release' ? `${p.invoice.invoice_number} was paid ${pretty(p.assumed_payment_date)} (PayPal)` : `If ${p.invoice.invoice_number} is paid ${pretty(p.assumed_payment_date)} (${p.assumption_source === 'model' ? 'agent assumption' : 'policy: today + 7d'})`}: ${moves || 'milestone only'}; ${p.invoice.client} delivery ${p.client_deadline_slip_days >= 0 ? 'slips' : 'gains'} ${Math.abs(p.client_deadline_slip_days)}d.${conflicts ? ` ⚠ ${conflicts}.` : ''}${resolved ? ` ✓ ${resolved}.` : ''} Dashed bars = proposed dates.`));
}

async function applyApproved(ev: { confirmation_id: string; invoice_number: string; plan_date: string }) {
  showGhost(null);
  stm.startTransaction(ev.confirmation_id);
  try {
    const tranches = gantt.taskStore.query((r: unknown) => rec(r).kind === 'tranche' && rec(r).invoiceNumber === ev.invoice_number) as TrancheTask[];
    // Re-constrain the tranche milestone; the Bryntum engine propagates the finish-to-start chain to every dependent phase.
    for (const t of tranches) await (t as any).setConstraint('startnoearlierthan', new Date(toBryntumDate(ev.plan_date)));
    await gantt.project.commitAsync();
    stm.stopTransaction(ev.confirmation_id);
  } catch (err) {
    stm.rejectTransaction();
    throw err;
  }
  return report('apply', ev.confirmation_id);
}

async function undoApplied(ev: { confirmation_id: string }) {
  const top = stm.queue[stm.position - 1];
  if (top !== ev.confirmation_id) { toast(`Undo of ${ev.confirmation_id} was done elsewhere; reload to resync.`); return; }
  await stm.undo();
  await gantt.project.commitAsync();
  return report('undo', ev.confirmation_id);
}

// --- panel rendering ----------------------------------------------------------------------------------------
function renderTop(s: State) {
  const a = s.modes.agent;
  const badge = $('agent-mode');
  badge.textContent = a.live ? `Agent: LIVE · ${a.label}` : `Agent: SCRIPTED (no LLM)`;
  badge.className = `pill ${a.live ? 'live' : 'scripted'}`;
  badge.title = a.reason || a.label;
  $('paypal-mode').textContent = `PayPal: ${s.modes.paypal.toUpperCase()}`;
  $('clock').textContent = `Demo today: ${pretty(s.today)} 2026`;
  const inv = $('invoices'); inv.replaceChildren();
  for (const i of s.invoices) {
    const d = el('div', `inv ${i.state}`);
    d.dataset.invoice = i.invoice_number;
    const top = el('div', 'l1'); const sub = el('div', 'l2');
    top.append(el('b', '', i.invoice_number), document.createTextNode(` · €${Number(i.amount.split(' ')[0]).toLocaleString('en-IE')} · ${i.status}`));
    if (i.days_overdue) top.append(document.createTextNode(' · '), el('b', 'late', `${i.days_overdue}d overdue`));
    sub.textContent = `${i.client} · due ${pretty(i.due_date)}${i.paid_date ? ` · paid ${pretty(i.paid_date)}` : ''}`;
    d.append(top, sub);
    inv.append(d);
  }
  const sel = $<HTMLSelectElement>('sim-invoice');
  const cur = sel.value;
  sel.replaceChildren(...s.invoices.map((i) => { const o = el('option', '', `${i.invoice_number} · ${i.client} · ${i.status}`) as HTMLOptionElement; o.value = i.invoice_number; return o; }));
  sel.value = cur || 'INV-2';
}

let activity = '';
function renderTranscript(s: State) {
  const box = $('transcript');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
  box.replaceChildren();
  for (const m of s.transcript) {
    const d = el('div', `msg ${m.role}${m.role === 'agent' ? (m.live ? ' live' : ' scripted') : ''}`);
    d.dataset.role = m.role;
    if (m.role === 'agent') d.append(el('span', 'who', m.live ? `Agent · ${s.modes.agent.model || 'LLM'}` : 'Scripted agent (no LLM)'));
    if (m.role === 'event') d.append(el('span', 'who', 'PayPal event'));
    d.append(document.createTextNode(m.text));
    if (m.tool_calls?.length) {
      const tools = el('div', 'tools');
      for (const c of m.tool_calls) tools.append(el('span', `tool${c.ok ? '' : ' err'}`, `${c.tool}(${JSON.stringify(c.args).slice(0, 90)})${c.ok ? '' : ` ✗ ${c.error?.code}`}`));
      d.append(tools);
    }
    box.append(d);
  }
  if (s.agent_busy) box.append(el('div', 'activity', activity || 'Agent is thinking…'));
  if (atBottom) box.scrollTop = box.scrollHeight;
  $('agent-status').textContent = s.agent_busy ? 'working…' : '';
}

function renderConfirmations(s: State) {
  const box = $('confirmations'); box.replaceChildren();
  const pending = s.confirmations.filter((c) => c.status === 'pending');
  const list = [...pending, ...s.confirmations.filter((c) => c.status !== 'pending').reverse()].slice(0, Math.max(4, pending.length));
  if (!list.length) box.append(el('div', 'activity', 'No requests yet. The agent will ask here before anything changes.'));
  for (const c of list) {
    const d = el('div', `conf ${c.status}`);
    d.dataset.confirmation = c.id;
    const head = el('div', 'head');
    head.append(el('span', '', `${c.id} · ${c.kind === 'apply_schedule' ? 'Schedule change' : 'PayPal reminder'} · by ${c.requested_by}`), el('span', 'status', c.status));
    d.append(head, el('div', '', c.summary));
    if (c.kind === 'send_reminder' && c.payload?.friendly_note) d.append(el('div', 'note', `Friendly note: ${c.payload.friendly_note}`));
    const meta = el('div', 'head'); meta.append(el('span', 'hash', `payload sha256 ${c.payload_hash.slice(0, 12)}…`), el('span', '', c.resolution || ''));
    d.append(meta);
    if (c.status === 'pending') {
      const actions = el('div', 'actions');
      const apply = el('button', 'apply', c.kind === 'apply_schedule' ? 'Apply to plan' : 'Send PayPal reminder') as HTMLButtonElement;
      const reject = el('button', 'reject', 'Reject') as HTMLButtonElement;
      apply.dataset.action = 'approve'; reject.dataset.action = 'reject';
      apply.onclick = () => post(`/api/confirmations/${c.id}/approve`, { payload_hash: c.payload_hash }).catch((e) => toast(`${e.code || 'Error'}: ${e.message}`));
      reject.onclick = () => post(`/api/confirmations/${c.id}/reject`, { reason: 'rejected by owner in UI' }).catch((e) => toast(e.message));
      actions.append(apply, reject);
      d.append(actions);
    }
    box.append(d);
  }
  const btn = $<HTMLButtonElement>('undo');
  const top = stm.queue[stm.position - 1];
  btn.disabled = !stm.canUndo || s.applied.at(-1)?.confirmation_id !== top;
  btn.dataset.confirmation = top || '';
  $('undo-note').textContent = btn.disabled ? '' : `reverts ${top} via Bryntum STM`;
}

function renderEvents(s: State) {
  const box = $('events'); box.replaceChildren();
  for (const e of [...s.events].reverse().slice(0, 12)) {
    const d = el('div', 'ev'); d.append(el('code', '', e.event_type), document.createTextNode(` ${e.summary} `), el('small', '', `(${e.source}${e.initial ? ', at start-up' : ''})`));
    box.append(d);
  }
}

function renderAudit(s: State) {
  const box = $('audit'); box.replaceChildren();
  for (const a of [...s.audit].reverse().slice(0, 40)) {
    const d = el('div', '', `#${a.seq} ${a.at.slice(11, 19)} ${a.actor} ${a.action} ${JSON.stringify(a.details).slice(0, 140)}`);
    d.title = JSON.stringify(a.details, null, 1);
    box.append(d);
  }
}

function render(s: State) {
  state = s;
  renderTop(s); renderTranscript(s); renderConfirmations(s); renderEvents(s); renderAudit(s);
  void serial(async () => {
    refreshTaskFields(s);
    const want = s.last_preview;
    if ((want?.preview_id ?? null) !== (ghost?.preview_id ?? null)) showGhost(want);
  });
}

// --- wiring ---------------------------------------------------------------------------------------------------
const quick = $('quick');
for (const [label, prompt] of [
  ['Review overdue INV-2', 'Invoice INV-2 for Acme is 9 days overdue. What does that do to the plan?'],
  ['Check all tranches', 'Check every PayPal tranche on the board and tell me what needs my attention.'],
]) {
  const b = el('button', '', label) as HTMLButtonElement; b.dataset.prompt = prompt;
  b.onclick = () => ask(prompt);
  quick.append(b);
}
async function ask(prompt: string) { try { await post('/api/agent/ask', { prompt }); } catch (e) { toast((e as Error).message); } }
$('ask-form').addEventListener('submit', (e) => { e.preventDefault(); const i = $<HTMLInputElement>('ask-input'); const v = i.value.trim(); if (v) { i.value = ''; void ask(v); } });
$('undo').addEventListener('click', () => {
  const id = $('undo').dataset.confirmation;
  if (id) post('/api/schedule/undo', { confirmation_id: id }).catch((e) => toast(e.message));
});
document.querySelectorAll<HTMLButtonElement>('[data-sim]').forEach((b) => {
  b.onclick = () => post('/api/mock/simulate', { action: b.dataset.sim, invoice_number: $<HTMLSelectElement>('sim-invoice').value }).catch((e) => toast(`${e.code || ''} ${e.message}`));
});

await gantt.project.commitAsync();
render(initial);
await chain;
await report('load');

const es = new EventSource('/api/events');
es.addEventListener('state', (e) => render(JSON.parse((e as MessageEvent).data)));
es.addEventListener('agent', (e) => {
  const d = JSON.parse((e as MessageEvent).data);
  if (d.type === 'tool_start') activity = `Agent is calling ${d.tool}…`;
  if (d.type === 'status' && d.status === 'idle') activity = '';
  if (state) renderTranscript({ ...state, agent_busy: d.type !== 'status' || d.status !== 'idle' });
});
es.addEventListener('schedule.applied', (e) => { const d = JSON.parse((e as MessageEvent).data); void serial(() => applyApproved(d)).then(() => render(state)).catch((err) => toast(`Apply failed in Gantt: ${err.message}`)); });
es.addEventListener('schedule.undone', (e) => { const d = JSON.parse((e as MessageEvent).data); void serial(() => undoApplied(d)).then(() => render(state)).catch((err) => toast(`Undo failed: ${err.message}`)); });

Object.assign(T, { gantt, scheduler, stm, engineDates, stmInfo, idle: () => chain, ready: true });
