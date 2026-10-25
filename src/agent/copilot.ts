// Real LLM agent on the GitHub Copilot SDK. Two auth paths (see docs/FACTS_COPILOT_BYOK.md):
//   - the logged-in Copilot user (useLoggedInUser), or
//   - BYOK: TRANCHE_LLM_PROVIDER/_BASE_URL/_API_KEY/_MODEL (OpenAI-compatible incl. Ollama, Anthropic, Azure).
// Only our six tools are available (availableTools allow-list); every other permission request is rejected.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CopilotClient, ToolSet, defineTool } from '@github/copilot-sdk';
import type { CopilotClientOptions, CopilotSession, ProviderConfig, SessionConfig, SessionEvent } from '@github/copilot-sdk';
import { ROOT } from '../server/static.ts';
import { TOOL_NAMES, TOOL_SPECS, runTool, type ToolCallRecord, type ToolHost } from './tools.ts';
import type { AgentEvent, AgentInfo, AgentRunner, AgentTurn } from './runner.ts';

export const DEFAULT_MODEL = 'gpt-6-luna';

export function byokProviderFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderConfig | undefined {
  let type = env.TRANCHE_LLM_PROVIDER?.trim().toLowerCase();
  if (!type) return undefined;
  let baseUrl = env.TRANCHE_LLM_BASE_URL;
  if (type === 'ollama') { type = 'openai'; baseUrl ||= 'http://127.0.0.1:11434/v1'; }
  if (!['openai', 'azure', 'anthropic'].includes(type)) throw new Error(`TRANCHE_LLM_PROVIDER must be openai, azure, anthropic or ollama (got ${type})`);
  const defaults: Record<string, string> = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com' };
  baseUrl ||= defaults[type];
  if (!baseUrl) throw new Error('TRANCHE_LLM_BASE_URL is required for azure');
  return {
    type: type as ProviderConfig['type'], baseUrl, apiKey: env.TRANCHE_LLM_API_KEY || undefined,
    ...(type === 'azure' && env.TRANCHE_AZURE_API_VERSION ? { azure: { apiVersion: env.TRANCHE_AZURE_API_VERSION } } : {}),
  };
}

export function systemPrompt(today: string) {
  return `You are Tranche, the planning agent on a freelancer's delivery board. Client projects are split into phases; each phase after the first waits for a PayPal invoice "tranche" to be paid.
Today is ${today}.
Rules:
- Start by calling get_board_status unless you already know the board state from this conversation.
- Never compute, estimate or invent dates or day counts. Only quote dates and numbers returned by tools.
- For an unpaid tranche that is overdue, refunded or cancelled: call schedule_shift_preview. You may pass assumed_payment_date (YYYY-MM-DD, today or later) only if the owner gave a basis; otherwise omit it to use the policy default.
- For a paid tranche whose plan date differs from its PayPal payment date: call schedule_release_preview.
- If a preview moves anything, call request_schedule_change with its preview_id so the owner can approve it. You cannot apply changes yourself.
- For an overdue unpaid invoice, call get_reminder_facts and, if can_remind_now is true, call request_payment_reminder with a short, warm friendly_note.
- Then answer in at most 4 short plain-text sentences: what moves and by how much, client delivery slip, team booking conflicts, and which approval cards are waiting. Say nothing has been applied yet.`;
}

export type CopilotAgentOptions = {
  client: CopilotClient;
  provider?: ProviderConfig;
  model: string;
  auth: string;
  today: string;
  liveLog?: string;
  timeoutMs?: number;
};

export function buildSessionConfig(tools: ReturnType<typeof defineTool>[], o: Pick<CopilotAgentOptions, 'provider' | 'model' | 'today'>): SessionConfig {
  const allow = new ToolSet();
  for (const n of TOOL_NAMES) allow.addCustom(n);
  return {
    clientName: 'tranche-agent',
    model: o.model,
    ...(o.provider ? { provider: o.provider } : {}),
    workingDirectory: ROOT,
    tools,
    availableTools: allow,
    onPermissionRequest: () => ({ kind: 'reject', feedback: 'Only the Tranche board tools are available.' }),
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
    systemMessage: { mode: 'customize', content: systemPrompt(o.today), sections: { environment_context: { action: 'remove' } } },
  };
}

export function clientOptionsFor(provider?: ProviderConfig): CopilotClientOptions {
  return provider
    // BYOK: no stored GitHub credentials are consulted; isolated COPILOT_HOME inside the repo (git-ignored).
    ? { useLoggedInUser: false, baseDirectory: resolve(ROOT, 'artifacts/runtime/copilot-home'), workingDirectory: ROOT, logLevel: 'error' }
    : { useLoggedInUser: true, workingDirectory: ROOT, logLevel: 'error' };
}

type Collector = { calls: ToolCallRecord[]; requests: number; messages: string[]; onEvent: (e: AgentEvent) => void };

export class CopilotAgent implements AgentRunner {
  info: AgentInfo;
  private session?: CopilotSession;
  private current?: Collector;
  private host: ToolHost;
  private o: CopilotAgentOptions;
  constructor(host: ToolHost, o: CopilotAgentOptions) {
    this.host = host; this.o = o;
    this.info = {
      mode: o.provider ? 'byok' : 'copilot', live: true, model: o.model, auth: o.auth, provider: o.provider?.type,
      label: o.provider ? `BYOK ${o.provider.type} · ${o.model}` : `Copilot · ${o.model}`,
    };
  }

  private async ensureSession() {
    if (this.session) return this.session;
    const tools = TOOL_SPECS.map((spec) => defineTool(spec.name, {
      description: spec.description,
      parameters: spec.parameters,
      skipPermission: true,
      handler: async (args: unknown) => {
        const c = this.current;
        const a = (args ?? {}) as Record<string, unknown>;
        c?.onEvent({ type: 'tool_start', tool: spec.name, args: a });
        const out = runTool(spec.name, a, this.host, { agent: this.info.mode }, c?.calls);
        if (c) c.onEvent({ type: 'tool_done', record: c.calls.at(-1)! });
        return JSON.stringify(out);
      },
    }));
    const session = await this.o.client.createSession(buildSessionConfig(tools, this.o));
    session.on((event: SessionEvent) => {
      const c = this.current; if (!c) return;
      const data = (event as { data?: Record<string, unknown> }).data || {};
      if (event.type === 'assistant.usage') c.requests++;
      else if (event.type === 'assistant.message' && typeof data.content === 'string' && data.content.trim() && !(Array.isArray(data.toolRequests) && data.toolRequests.length)) c.messages.push(data.content);
    });
    this.session = session;
    return session;
  }

  async ask(prompt: string, opts: { turnId: string; trigger: AgentTurn['trigger']; onEvent: (e: AgentEvent) => void }): Promise<AgentTurn> {
    const started = Date.now();
    const c: Collector = { calls: [], requests: 0, messages: [], onEvent: opts.onEvent };
    this.current = c;
    let text = ''; let ok = true; let error: string | undefined;
    try {
      const session = await this.ensureSession();
      const result = await session.sendAndWait({ prompt }, this.o.timeoutMs ?? 180_000);
      text = c.messages.at(-1) ?? (result as { data?: { content?: string } } | undefined)?.data?.content ?? '';
    } catch (err) {
      ok = false; error = (err as Error).message; text = `Agent error: ${error}`;
    } finally {
      this.current = undefined;
    }
    const turn: AgentTurn = { turn_id: opts.turnId, mode: this.info.mode, live: true, model: this.o.model, trigger: opts.trigger, prompt, text, tool_calls: c.calls, model_requests: c.requests, duration_ms: Date.now() - started, ok, error };
    if (this.o.liveLog) {
      mkdirSync(dirname(this.o.liveLog), { recursive: true });
      appendFileSync(this.o.liveLog, JSON.stringify({ at: new Date().toISOString(), auth: this.o.auth, live_user_turns: 1, ...turn }) + '\n');
    }
    opts.onEvent({ type: 'message', text });
    return turn;
  }

  async stop() {
    await this.session?.disconnect().catch(() => {});
    await this.o.client.stop().catch(() => {});
  }
}

export type AgentChoice = { kind: 'scripted'; reason: string } | { kind: 'llm'; client: CopilotClient; provider?: ProviderConfig; model: string; auth: string };

// Decide which agent to run. Never throws for a missing login: falls back to the labelled scripted agent.
export async function chooseAgent(env: NodeJS.ProcessEnv = process.env): Promise<AgentChoice> {
  if (env.TRANCHE_AGENT === 'scripted') return { kind: 'scripted', reason: 'TRANCHE_AGENT=scripted' };
  const provider = byokProviderFromEnv(env);
  const model = env.TRANCHE_LLM_MODEL || env.COPILOT_MODEL || DEFAULT_MODEL;
  if (provider && !env.TRANCHE_LLM_MODEL) throw new Error('TRANCHE_LLM_MODEL is required with TRANCHE_LLM_PROVIDER (e.g. gpt-4.1, claude-sonnet-4, llama3.1)');
  const client = new CopilotClient(clientOptionsFor(provider));
  try {
    await client.start();
  } catch (err) {
    await client.stop().catch(() => {});
    return { kind: 'scripted', reason: `Copilot runtime did not start: ${(err as Error).message}` };
  }
  if (provider) return { kind: 'llm', client, provider, model, auth: `byok:${provider.type}` };
  try {
    const auth = await client.getAuthStatus();
    if (!auth.isAuthenticated) { await client.stop().catch(() => {}); return { kind: 'scripted', reason: `No Copilot login (${auth.statusMessage || 'not authenticated'}); set TRANCHE_LLM_* for BYOK` }; }
    if (env.EXPECTED_GITHUB_LOGIN && auth.login !== env.EXPECTED_GITHUB_LOGIN) {
      await client.stop().catch(() => {});
      throw new Error(`Copilot is logged in as ${auth.login}, expected ${env.EXPECTED_GITHUB_LOGIN}; refusing to run.`);
    }
    return { kind: 'llm', client, model, auth: `copilot-login:${auth.login}` };
  } catch (err) {
    if (/refusing to run/.test((err as Error).message)) throw err;
    await client.stop().catch(() => {});
    return { kind: 'scripted', reason: `Copilot auth check failed: ${(err as Error).message}` };
  }
}
