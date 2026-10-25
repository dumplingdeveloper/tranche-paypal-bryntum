// LIVE end-to-end run: a real model (Copilot login, or BYOK via TRANCHE_LLM_*) drives the real UI.
// Skipped unless TRANCHE_LIVE=1 (npm run test:live). Two live user turns per run. The scripted agent is never accepted
// here: if no LLM is available the test fails instead of silently falling back.
// Every screenshot and evidence file is written by this test (artifacts/screenshots/live, artifacts/live).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { CopilotAgent, chooseAgent, type AgentChoice } from '../../src/agent/copilot.ts';
import { ROOT } from '../../src/server/static.ts';
import { DEMO_TODAY } from '../../src/domain/mockData.ts';
import { apiState, engineDates, launch, openBoard, shot, startApp, stmInfo, waitFor, waitReport, writeEvidence, type Browser } from '../e2e/harness.ts';

const LIVE = process.env.TRANCHE_LIVE === '1';
const LIVE_LOG = resolve(ROOT, 'artifacts/live/live-runs.jsonl');
let browser: Browser;
let choice: AgentChoice;

before(async () => {
  if (!LIVE) return;
  choice = await chooseAgent(process.env);
  browser = await launch();
});
after(async () => {
  await browser?.close();
  if (choice?.kind === 'llm') await choice.client.stop().catch(() => {});
});

const ACME = ['acme-t2', 'acme-build', 'acme-t3', 'acme-launch'];
const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));

test('LIVE: real model previews INV-2, owner applies in the UI, client pays, model proposes the release, owner applies', { skip: !LIVE && 'set TRANCHE_LIVE=1 (npm run test:live)', timeout: 600_000 }, async () => {
  assert.equal(choice.kind, 'llm', `no LLM available: ${(choice as { reason?: string }).reason}`);
  if (choice.kind !== 'llm') return;
  const runId = `live-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const { app, base } = await startApp({
    today: DEMO_TODAY,
    autoWatch: false, // exactly the two owner prompts below reach the model
    agent: (host) => new CopilotAgent(host, { client: choice.kind === 'llm' ? choice.client : (undefined as never), provider: choice.kind === 'llm' ? choice.provider : undefined, model: choice.kind === 'llm' ? choice.model : '', auth: choice.kind === 'llm' ? choice.auth : '', today: DEMO_TODAY, liveLog: LIVE_LOG, timeoutMs: 240_000 }),
  });
  const evidence: Record<string, unknown> = { run_id: runId, model: choice.model, auth: choice.auth, agent: app.agent.info };
  try {
    const { page, context, errors } = await openBoard(browser, base);
    const before = await engineDates(page);

    // ---- live turn 1: owner types the overdue question into the real UI ----
    await page.fill('#ask-input', 'Invoice INV-2 for Acme is 9 days overdue. What should happen to the plan?');
    await page.click('#ask-form button');
    await waitFor(() => app.turns.length >= 1, 300_000, 'live turn 1');
    const t1 = app.turns[0];
    assert.equal(t1.live, true);
    assert.ok(t1.ok, t1.error ?? "turn 1 failed");
    const t1Tools = t1.tool_calls.map((c) => c.tool);
    const preview = t1.tool_calls.find((c) => c.tool === 'schedule_shift_preview' && c.ok);
    assert.ok(preview, `model did not call schedule_shift_preview: ${JSON.stringify(t1Tools)}`);
    assert.equal(preview.args.invoice_number, 'INV-2');
    let s = await apiState(base);
    const card = s.confirmations.find((c: any) => c.kind === 'apply_schedule' && c.status === 'pending' && c.invoice_number === 'INV-2');
    assert.ok(card, `model did not request a schedule change: ${JSON.stringify(t1Tools)}`);
    assert.equal(card.requested_by, app.agent.info.mode);
    // The moved dates come from OUR scheduler (payload), never from the model's text.
    const moves = card.payload.moved as Array<{ task_id: string; new_start: string; new_end: string }>;
    assert.ok(moves.length >= 2, 'preview moves the dependent phases');
    assert.deepEqual(pick(await engineDates(page), ACME), pick(before, ACME), 'nothing moves before approval');
    assert.deepEqual(await stmInfo(page), { position: 0, queue: [], canUndo: false });
    await page.waitForSelector(`[data-confirmation="${card.id}"] button[data-action=approve]`);
    const shot1 = await shot(page, 'L1-live-preview-INV-2');

    await page.click(`[data-confirmation="${card.id}"] button[data-action=approve]`);
    await waitReport(page, 'apply', card.id, 30_000);
    const applied = await engineDates(page);
    s = await apiState(base);
    assert.deepEqual(applied, s.schedule, 'Bryntum engine = server scheduler after the live-approved change');
    for (const m of moves) assert.deepEqual(applied[m.task_id], { start: m.new_start, end: m.new_end }, `engine date for ${m.task_id} equals the approved preview`);
    assert.deepEqual(await stmInfo(page), { position: 1, queue: [card.id], canUndo: true });
    assert.ok(s.audit.some((e: any) => e.action === 'confirmation.approved' && e.details.id === card.id));
    assert.ok(s.audit.some((e: any) => e.action === 'engine.verified' && e.details.reason === 'apply' && e.details.confirmation_id === card.id));
    const shot2 = await shot(page, 'L2-live-applied-INV-2');

    // ---- the client pays (mock PayPal), then live turn 2 ----
    await page.click('details.demo summary');
    await page.selectOption('#sim-invoice', 'INV-2');
    await page.click('[data-sim=payer_pays]');
    await waitFor(async () => (await apiState(base)).invoices.find((i: any) => i.invoice_number === 'INV-2').status === 'PAID', 10_000, 'INV-2 PAID');
    await page.fill('#ask-input', 'INV-2 was just paid on PayPal. Update the plan?');
    await page.click('#ask-form button');
    await waitFor(() => app.turns.length >= 2, 300_000, 'live turn 2');
    const t2 = app.turns[1];
    assert.ok(t2.ok, t2.error ?? "turn 2 failed");
    const release = t2.tool_calls.find((c) => c.tool === 'schedule_release_preview' && c.ok);
    assert.ok(release, `model did not call schedule_release_preview: ${JSON.stringify(t2.tool_calls.map((c) => c.tool))}`);
    s = await apiState(base);
    const card2 = s.confirmations.find((c: any) => c.kind === 'apply_schedule' && c.status === 'pending' && c.invoice_number === 'INV-2');
    assert.ok(card2, 'model requested the release change');
    assert.equal(card2.payload.assumption_source, 'paypal_payment_date');
    await page.waitForSelector(`[data-confirmation="${card2.id}"] button[data-action=approve]`);
    const shot3 = await shot(page, 'L3-live-release-preview');
    await page.click(`[data-confirmation="${card2.id}"] button[data-action=approve]`);
    await waitReport(page, 'apply', card2.id, 30_000);
    const released = await engineDates(page);
    s = await apiState(base);
    assert.deepEqual(released, s.schedule);
    assert.deepEqual(pick(released, ['acme-t2', 'acme-build']), { 'acme-t2': { start: '2026-11-03', end: '2026-11-03' }, 'acme-build': { start: '2026-11-03', end: '2026-11-24' } });
    assert.deepEqual(await stmInfo(page), { position: 2, queue: [card.id, card2.id], canUndo: true });
    assert.deepEqual(errors, []);
    const shot4 = await shot(page, 'L4-live-release-applied');

    const turnSummary = app.turns.map((t) => ({ turn_id: t.turn_id, mode: t.mode, model: t.model, live: t.live, prompt: t.prompt, model_requests: t.model_requests, duration_ms: t.duration_ms, tool_calls: t.tool_calls.map((c) => ({ tool: c.tool, args: c.args, ok: c.ok, error: c.error })), text: t.text }));
    Object.assign(evidence, {
      live_user_turns: app.turns.length,
      model_requests_total: app.turns.reduce((n, t) => n + (t.model_requests || 0), 0),
      turns: turnSummary,
      confirmations: [card.id, card2.id],
      preview_moves: moves,
      engine_after_apply: pick(applied, ACME),
      engine_after_release: pick(released, ACME),
      stm: await stmInfo(page),
      audit_actions: s.audit.map((e: any) => `${e.actor}:${e.action}`),
      screenshots: [shot1, shot2, shot3, shot4],
    });
    writeEvidence(runId, evidence);
    await context.close();
  } finally {
    await app.close();
  }
});
