import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranche } from '../../src/server/app.ts';
import { ScriptedAgent, SCRIPTED_LABEL } from '../../src/agent/scripted.ts';
import { TOOL_NAMES, TOOL_SPECS, runTool, type ToolHost } from '../../src/agent/tools.ts';
import type { AgentRunner } from '../../src/agent/runner.ts';

// A stub runner that just captures the ToolHost the app wires up, so tools can be driven directly.
async function appWithHost() {
  let host!: ToolHost;
  const stub: AgentRunner = { info: { mode: 'scripted', label: 'stub', live: false }, ask: async () => { throw new Error('unused'); }, stop: async () => {} };
  const app = await createTranche({ agent: (h) => { host = h; return stub; } });
  return { app, host };
}

const meta = { agent: 'test' };
const freeze = (app: Awaited<ReturnType<typeof createTranche>>) => JSON.stringify({ plan: app.board.planDates, applied: app.board.applied, invoices: app.board.invoices, calls: app.invoicing.calls });

test('exactly six tools; none of them changes the plan or calls PayPal', async () => {
  const { app, host } = await appWithHost();
  assert.deepEqual(TOOL_NAMES, ['get_board_status', 'schedule_shift_preview', 'schedule_release_preview', 'request_schedule_change', 'get_reminder_facts', 'request_payment_reminder']);
  const before = freeze(app);
  const s = runTool('schedule_shift_preview', { invoice_number: 'INV-2', assumed_payment_date: '2026-11-12' }, host, meta) as any;
  assert.equal(s.ok, true);
  assert.equal(s.applied, false);
  runTool('get_board_status', {}, host, meta);
  const req = runTool('request_schedule_change', { preview_id: s.preview.preview_id }, host, meta) as any;
  runTool('get_reminder_facts', { invoice_number: 'INV-2' }, host, meta);
  const rem = runTool('request_payment_reminder', { invoice_number: 'INV-2', friendly_note: 'Hi!' }, host, meta) as any;
  assert.equal(req.status, 'pending_owner_approval');
  assert.equal(rem.status, 'pending_owner_approval');
  assert.equal(freeze(app), before, 'tools must not mutate the board or call PayPal');
  assert.deepEqual(app.broker.list().map((c) => [c.kind, c.status, c.preview_id ?? null]), [['apply_schedule', 'pending', 'pv_shift_INV-2_2026-11-12'], ['send_reminder', 'pending', null]]);
  assert.deepEqual(app.audit.find('agent.tool_call').map((e) => e.details.tool), ['schedule_shift_preview', 'get_board_status', 'request_schedule_change', 'get_reminder_facts', 'request_payment_reminder']);
  await app.close();
});

test('tool errors are returned to the model, not thrown; model dates in the past are refused', async () => {
  const { app, host } = await appWithHost();
  const r = runTool('schedule_shift_preview', { invoice_number: 'INV-2', assumed_payment_date: '2026-10-01' }, host, meta) as any;
  assert.deepEqual(r, { ok: false, error: { code: 'DATE_IN_PAST', message: 'assumed_payment_date must be on or after today (2026-11-03)' } });
  assert.equal((runTool('request_schedule_change', { preview_id: 'pv_made_up' }, host, meta) as any).error.code, 'UNKNOWN_PREVIEW');
  assert.equal((runTool('schedule_release_preview', { invoice_number: 'INV-2' }, host, meta) as any).error.code, 'NOT_PAID');
  assert.equal((runTool('request_payment_reminder', { invoice_number: 'INV-1', friendly_note: 'x' }, host, meta) as any).error.code, 'CANNOT_REMIND_INVOICE');
  assert.equal((runTool('no_such_tool', {}, host, meta) as any).error.code, 'UNKNOWN_TOOL');
  await app.close();
});

test('request_schedule_change refuses a preview made stale by an applied change', async () => {
  const { app, host } = await appWithHost();
  const p1 = (runTool('schedule_shift_preview', { invoice_number: 'INV-2' }, host, meta) as any).preview;
  const p2 = (runTool('schedule_shift_preview', { invoice_number: 'INV-2', assumed_payment_date: '2026-11-20' }, host, meta) as any).preview;
  const c1 = runTool('request_schedule_change', { preview_id: p1.preview_id }, host, meta) as any;
  await app.broker.approve(c1.confirmation_id, c1.payload_hash);
  assert.equal(app.board.planDates['INV-2'], '2026-11-10');
  const stale = runTool('request_schedule_change', { preview_id: p2.preview_id }, host, meta) as any;
  assert.equal(stale.error.code, 'PREVIEW_STALE');
  await app.close();
});

test('approved reminder calls (mock) PayPal remind; third one in a day is refused at request time', async () => {
  const { app, host } = await appWithHost();
  for (let i = 0; i < 2; i++) {
    const r = runTool('request_payment_reminder', { invoice_number: 'INV-2', friendly_note: `note ${i}` }, host, meta) as any;
    const c = await app.broker.approve(r.confirmation_id, r.payload_hash);
    assert.equal((c.result as any).mode, 'mock');
  }
  assert.equal(app.invoicing.remindersOn('INV-2'), 2);
  const third = runTool('request_payment_reminder', { invoice_number: 'INV-2', friendly_note: 'again' }, host, meta) as any;
  assert.equal(third.error.code, 'REMINDER_LIMIT_REACHED');
  assert.equal(app.audit.find('paypal.invoice.remind').length, 2);
  await app.close();
});

test('every tool spec is a closed JSON schema (no extra args accepted by the model)', () => {
  for (const t of TOOL_SPECS) assert.equal((t.parameters as any).additionalProperties, false, t.name);
});

test('scripted agent is labelled and drives only the same tools', async () => {
  const app = await createTranche({ agent: (h) => new ScriptedAgent(h) });
  assert.equal(app.agent.info.live, false);
  const turn = await app.askAgent('Invoice INV-2 for Acme is 9 days overdue', 'owner').done;
  assert.ok(turn.text.startsWith(`[${SCRIPTED_LABEL}]`));
  assert.equal(turn.live, false);
  assert.deepEqual(turn.tool_calls.map((c) => c.tool), ['get_board_status', 'schedule_shift_preview', 'request_schedule_change', 'get_reminder_facts', 'request_payment_reminder']);
  assert.ok(turn.tool_calls.every((c) => c.agent === 'scripted' && c.ok));
  assert.deepEqual(app.audit.find('agent.turn').map((e) => [e.details.mode, e.details.live]), [['scripted', false]]);
  assert.deepEqual(app.broker.list().map((c) => [c.kind, c.status]), [['apply_schedule', 'pending'], ['send_reminder', 'pending']]);
  await app.close();
});
