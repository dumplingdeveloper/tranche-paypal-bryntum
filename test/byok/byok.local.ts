// BYOK plumbing check with NO real key and NO network: the Copilot SDK runtime is pointed (TRANCHE_LLM_*) at a local
// stub of an OpenAI-compatible endpoint that records what it receives and answers 401. This proves the judge's
// BYOK path is wired (provider, model, key, and the tool allow-list the model is offered); it is NOT evidence of
// a model working (the stub never answers like a model).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import { CopilotAgent, chooseAgent } from '../../src/agent/copilot.ts';
import { TOOL_NAMES } from '../../src/agent/tools.ts';
import { createTranche } from '../../src/server/app.ts';
import { ROOT } from '../../src/server/static.ts';
import { freePort, writeEvidence } from '../e2e/harness.ts';

const FAKE_KEY = 'tranche-fake-key-not-a-secret';

test('BYOK (openai-compatible) → requests go to TRANCHE_LLM_BASE_URL with the given key + model; only the 6 Tranche tools are offered', { timeout: 180_000 }, async () => {
  const seen: Array<{ method: string; url: string; auth: string | undefined; model?: string; tools?: string[]; stream?: boolean }> = [];
  const stub = createServer(async (req: IncomingMessage, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    let j: any = {};
    try { j = JSON.parse(body || '{}'); } catch {}
    const tools = Array.isArray(j.tools) ? j.tools.map((t: any) => t.function?.name ?? t.name).filter(Boolean) : undefined;
    seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, model: j.model, tools, stream: j.stream });
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Incorrect API key provided (local stub)', type: 'invalid_request_error', code: 'invalid_api_key' } }));
  });
  const port = await freePort(4330);
  await new Promise<void>((r) => stub.listen(port, '127.0.0.1', () => r()));
  const env = { ...process.env, TRANCHE_LLM_PROVIDER: 'openai', TRANCHE_LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, TRANCHE_LLM_API_KEY: FAKE_KEY, TRANCHE_LLM_MODEL: 'gpt-4.1', TRANCHE_AGENT: '' };
  const choice = await chooseAgent(env);
  assert.equal(choice.kind, 'llm');
  if (choice.kind !== 'llm') return;
  assert.equal(choice.auth, 'byok:openai');
  const app = await createTranche({ today: '2026-11-03', autoWatch: false, auditFile: resolve(ROOT, 'artifacts/runtime/byok-audit.jsonl'), agent: (host) => new CopilotAgent(host, { client: choice.client, provider: choice.provider, model: choice.model, auth: choice.auth, today: '2026-11-03', timeoutMs: 90_000 }) });
  try {
    assert.equal(app.agent.info.mode, 'byok');
    const { done } = app.askAgent('Invoice INV-2 for Acme is 9 days overdue.', 'owner');
    const turn = await done;
    assert.equal(turn.ok, false, 'the stub never answers like a model');
    assert.ok(seen.length >= 1, 'the runtime called the BYOK endpoint');
    for (const s of seen) {
      assert.ok(s.url.startsWith('/v1/'), s.url);
      assert.equal(s.auth, `Bearer ${FAKE_KEY}`);
    }
    const withModel = seen.filter((s) => s.model);
    assert.ok(withModel.length >= 1);
    for (const s of withModel) assert.equal(s.model, 'gpt-4.1');
    const offered = withModel.find((s) => s.tools)?.tools;
    assert.deepEqual([...(offered ?? [])].sort(), [...TOOL_NAMES].sort(), 'only the Tranche tools are offered to the model');
    writeEvidence('byok-local-stub', {
      note: 'local stub, fake key, no network; proves BYOK wiring only',
      requests: seen.map((s) => ({ ...s, auth: s.auth === `Bearer ${FAKE_KEY}` ? 'Bearer <the fake key from TRANCHE_LLM_API_KEY>' : 'UNEXPECTED' })),
      turn_error: turn.error,
    });
  } finally {
    await app.close();
    await new Promise<void>((r) => stub.close(() => r()));
  }
});
