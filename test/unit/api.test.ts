import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTranche } from '../../src/server/app.ts';
import { ScriptedAgent } from '../../src/agent/scripted.ts';

const opened: Array<{ close: () => Promise<void> }> = [];
after(async () => { for (const a of opened) await a.close().catch(() => {}); });

async function start() {
  const app = await createTranche({ agent: (h) => new ScriptedAgent(h) });
  opened.push(app);
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) });
  const state = async () => (await (await fetch(`${base}/api/state`)).json()) as any;
  return { app, base, post, state };
}

test('POST guards: JSON only, same origin only', async () => {
  const { app, base, post } = await start();
  const form = await fetch(`${base}/api/agent/ask`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'prompt=hi' });
  assert.equal(form.status, 415);
  const cross = await post('/api/agent/ask', { prompt: 'hi' }, { origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
  assert.equal(app.transcript.filter((m) => m.role === 'owner').length, 0);
  assert.equal((await fetch(`${base}/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/src/server/app.ts`)).status, 404);
  assert.equal((await fetch(`${base}/web/../src/server/app.ts`)).status, 404);
});

test('ask → approve → engine report → undo, with broker + audit state at each step', async () => {
  const { app, post, state } = await start();
  assert.equal((await post('/api/agent/ask', { prompt: 'Invoice INV-2 for Acme is 9 days overdue' })).status, 202);
  while (!app.turns.length) await new Promise((r) => setTimeout(r, 10));
  let s = await state();
  const card = s.confirmations.find((c: any) => c.kind === 'apply_schedule');
  assert.equal(card.status, 'pending');
  assert.equal((await post(`/api/confirmations/${card.id}/approve`, { payload_hash: 'nope' })).status, 409);
  const ok = await post(`/api/confirmations/${card.id}/approve`, { payload_hash: card.payload_hash });
  assert.equal(ok.status, 200);
  s = await state();
  assert.equal(s.plan_dates['INV-2'], '2026-11-10');
  assert.deepEqual(s.schedule['acme-build'], { start: '2026-11-10', end: '2026-12-01' });
  assert.deepEqual(s.conflicts.map((c: any) => c.resource), ['dana']);

  const engine = Object.fromEntries(Object.entries(s.schedule).map(([k, v]) => [k, v]));
  const good = await (await post('/api/schedule/engine-report', { reason: 'apply', confirmation_id: card.id, engine })).json();
  assert.deepEqual(good, { checked: 12, matched: 12, mismatches: [] });
  const bad = await (await post('/api/schedule/engine-report', { reason: 'apply', engine: { ...engine, 'acme-build': { start: '2026-11-09', end: '2026-11-30' } } })).json();
  assert.equal(bad.mismatches.length, 1);

  assert.equal((await post('/api/schedule/undo', { confirmation_id: 'cf_9999' })).status, 409);
  const undo = await post('/api/schedule/undo', { confirmation_id: card.id });
  assert.equal(undo.status, 200);
  s = await state();
  assert.equal(s.plan_dates['INV-2'], '2026-10-25');
  assert.deepEqual(s.conflicts, []);
  const actions = s.audit.map((e: any) => e.action);
  for (const a of ['agent.mode', 'paypal.event', 'agent.tool_call', 'confirmation.requested', 'agent.turn', 'confirmation.hash_mismatch', 'schedule.applied', 'confirmation.approved', 'engine.verified', 'engine.mismatch', 'schedule.undone']) assert.ok(actions.includes(a), a);
});

test('mock simulate: payer pays INV-2 → PAID event → (auto-watch off) no agent turn; stale card after payment', async () => {
  const { app, post, state } = await start();
  await post('/api/agent/ask', { prompt: 'INV-2?' });
  while (!app.turns.length) await new Promise((r) => setTimeout(r, 10));
  let s = await state();
  const card = s.confirmations.find((c: any) => c.kind === 'apply_schedule');
  const remind = s.confirmations.find((c: any) => c.kind === 'send_reminder');
  const r = await (await post('/api/mock/simulate', { action: 'payer_pays', invoice_number: 'INV-2' })).json();
  assert.deepEqual(r.events.map((e: any) => [e.event_type, e.status_after]), [['INVOICING.INVOICE.PAID', 'PAID']]);
  // The shift preview assumed INV-2 was unpaid; after the payment it is no longer valid.
  const stale = await post(`/api/confirmations/${card.id}/approve`, { payload_hash: card.payload_hash });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'STALE');
  const staleRem = await post(`/api/confirmations/${remind.id}/approve`, { payload_hash: remind.payload_hash });
  assert.equal((await staleRem.json()).error.code, 'STALE');
  s = await state();
  assert.equal(s.plan_dates['INV-2'], '2026-10-25');
  assert.equal(s.mock_calls.filter((c: any) => c.op === 'remind').length, 0);
  assert.deepEqual(s.confirmations.map((c: any) => c.status), ['stale', 'stale']);
  assert.equal(app.turns.length, 1);
  assert.equal((await post('/api/mock/simulate', { action: 'explode', invoice_number: 'INV-2' })).status, 400);
});

test('auto-watch: a PayPal refund event wakes the agent, which proposes a shift for approval', async () => {
  const app = await createTranche({ agent: (h) => new ScriptedAgent(h), autoWatch: true });
  opened.push(app);
  await app.invoicing.recordRefund('INV-4', { refund_date: '2026-11-03', method: 'BANK_TRANSFER' });
  await app.watcher.poll();
  while (!app.turns.length) await new Promise((r) => setTimeout(r, 10));
  const t = app.turns[0];
  assert.equal(t.trigger, 'paypal-event');
  const shift = t.tool_calls.find((c) => c.tool === 'schedule_shift_preview')!;
  assert.deepEqual(shift.args.invoice_number, 'INV-4');
  assert.deepEqual(app.broker.list().map((c) => [c.kind, c.invoice_number, c.status]), [['apply_schedule', 'INV-4', 'pending']]);
});
