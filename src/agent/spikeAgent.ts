// Spike B: a Copilot SDK session where the MODEL decides to call schedule_shift_preview.
// Auth: the already-logged-in Copilot user (default) or BYOK via TRANCHE_LLM_* env vars (no GitHub login needed).
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CopilotClient, ToolSet } from '@github/copilot-sdk';
import type { CopilotClientOptions, ProviderConfig, SessionConfig, SessionEvent } from '@github/copilot-sdk';
import { DEMO_TODAY } from '../domain/mockData.ts';
import { createShiftPreviewTool, type ShiftToolCall } from './shiftTool.ts';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PROMPT = process.argv.slice(2).join(' ') || 'Invoice INV-2 for Acme is 9 days overdue';

export function byokProviderFromEnv(env = process.env): ProviderConfig | undefined {
  const type = env.TRANCHE_LLM_PROVIDER as ProviderConfig['type'] | undefined;
  if (!type) return undefined;
  const defaults: Record<string, string> = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com' };
  const baseUrl = env.TRANCHE_LLM_BASE_URL || defaults[type];
  if (!baseUrl) throw new Error('TRANCHE_LLM_BASE_URL is required for this provider');
  return { type, baseUrl, apiKey: env.TRANCHE_LLM_API_KEY || undefined, ...(type === 'azure' && env.TRANCHE_AZURE_API_VERSION ? { azure: { apiVersion: env.TRANCHE_AZURE_API_VERSION } } : {}) };
}

export const SYSTEM_PROMPT = `You are Tranche, the planning assistant on a freelancer's delivery board. Client projects are split into phases; each phase after the first depends on a PayPal invoice tranche being paid.
Today is ${DEMO_TODAY}.
When the owner reports a late, failed, overdue or refunded invoice, call schedule_shift_preview first. You may choose assumed_payment_date (YYYY-MM-DD, today or later) if you have a sensible basis; otherwise omit it.
Never compute or invent dates yourself: only report dates returned by the tool.
Then answer in at most 4 short sentences, plain text: which phases move and by how many days, how much the client's launch slips, which projects are unaffected, and that nothing has been applied until the owner confirms.`;

export function buildSessionConfig(tool: ReturnType<typeof createShiftPreviewTool>, provider?: ProviderConfig): SessionConfig {
  return {
    clientName: 'tranche-spike-agent',
    model: process.env.TRANCHE_LLM_MODEL || process.env.COPILOT_MODEL || 'gpt-6-luna',
    ...(provider ? { provider } : {}),
    workingDirectory: ROOT,
    tools: [tool],
    availableTools: new ToolSet().addCustom('schedule_shift_preview'),
    onPermissionRequest: () => ({ kind: 'reject', feedback: 'Only schedule_shift_preview is available on this board.' }),
    includedBuiltinSkills: [],
    skipCustomInstructions: true,
    enableConfigDiscovery: false,
    enableSessionTelemetry: false,
    skipEmbeddingRetrieval: true,
    embeddingCacheStorage: 'in-memory',
    enableOnDemandInstructionDiscovery: false,
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableSessionStore: false,
    coauthorEnabled: false,
    manageScheduleEnabled: false,
    memory: { enabled: false },
    toolSearch: { enabled: false },
    infiniteSessions: { enabled: false },
    systemMessage: { mode: 'customize', content: SYSTEM_PROMPT, sections: { environment_context: { action: 'remove' } } },
  };
}

export async function runSpike(prompt = PROMPT) {
  const provider = byokProviderFromEnv();
  const clientOptions: CopilotClientOptions = provider
    // BYOK: no stored GitHub credentials are consulted; isolated COPILOT_HOME.
    ? { useLoggedInUser: false, baseDirectory: resolve(ROOT, 'artifacts/tmp/copilot-home'), workingDirectory: ROOT, logLevel: 'error' }
    : { useLoggedInUser: true, workingDirectory: ROOT, logLevel: 'error' };
  const client = new CopilotClient(clientOptions);
  const calls: ShiftToolCall[] = [];
  const events: Array<Record<string, unknown>> = [];
  const started = Date.now();
  await client.start();
  try {
    let login: string | undefined;
    if (!provider) {
      const auth = await client.getAuthStatus();
      if (!auth.isAuthenticated) throw new Error(`Copilot not authenticated: ${auth.statusMessage || 'unknown'}`);
      login = auth.login;
      if (process.env.EXPECTED_GITHUB_LOGIN && login !== process.env.EXPECTED_GITHUB_LOGIN) throw new Error(`Logged in as ${login}, expected ${process.env.EXPECTED_GITHUB_LOGIN}; refusing to run.`);
    }
    const tool = createShiftPreviewTool(calls);
    const config = buildSessionConfig(tool, provider);
    const session = await client.createSession(config);
    session.on((event: SessionEvent) => {
      const data = (event as { data?: Record<string, unknown> }).data || {};
      if (event.type === 'tool.execution_start') events.push({ type: event.type, toolName: data.toolName, arguments: data.arguments, model: data.model });
      else if (event.type === 'assistant.usage') events.push({ type: event.type, model: data.model, inputTokens: data.inputTokens, outputTokens: data.outputTokens });
      else if (event.type === 'assistant.turn_start' || event.type === 'session.error') events.push({ type: event.type, message: data.message });
      else if (event.type === 'assistant.message') events.push({ type: event.type, content: data.content, toolRequests: Array.isArray(data.toolRequests) ? data.toolRequests.length : 0 });
    });
    const result = await session.sendAndWait({ prompt }, Number(process.env.TRANCHE_TIMEOUT_MS || 120_000));
    await session.disconnect().catch(() => {});
    const finalText = [...events].reverse().find((e) => e.type === 'assistant.message' && e.content && !e.toolRequests)?.content
      ?? (result as { data?: { content?: string } } | undefined)?.data?.content ?? '';
    const run = {
      at: new Date().toISOString(), durationMs: Date.now() - started, auth: provider ? `byok:${provider.type}` : `copilot-login:${login}`,
      model: config.model, prompt, liveUserTurns: 1, modelRequests: events.filter((e) => e.type === 'assistant.usage').length,
      toolCalls: calls.map((c) => ({ args: c.args, error: c.error, moved: c.result?.moved.map((m) => `${m.task_id} ${m.old_start}->${m.new_start} (${m.delta_days >= 0 ? '+' : ''}${m.delta_days}d)`), slip: c.result?.client_deadline_slip_days })),
      finalText, events,
    };
    await mkdir(resolve(ROOT, 'artifacts/logs'), { recursive: true });
    const file = resolve(ROOT, `artifacts/logs/agent-run-${provider ? 'byok' : 'copilot'}-${run.at.replace(/[:.]/g, '-')}.json`);
    await writeFile(file, JSON.stringify(run, null, 2));
    return { ...run, file };
  } finally {
    await client.stop().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSpike().then((run) => { console.log(JSON.stringify(run, null, 2)); }).catch((err) => { console.error('SPIKE_FAILED', err?.message || err); process.exitCode = 1; });
}
