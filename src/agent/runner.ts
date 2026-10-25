import type { ToolCallRecord } from './tools.ts';

export type AgentMode = 'copilot' | 'byok' | 'scripted';
export type AgentInfo = {
  mode: AgentMode;
  label: string;
  live: boolean; // true only when a real model answers
  model?: string;
  provider?: string;
  auth?: string;
  reason?: string;
};

export type AgentEvent =
  | { type: 'status'; status: 'thinking' | 'idle' | 'error'; message?: string }
  | { type: 'tool_start'; tool: string; args: Record<string, unknown> }
  | { type: 'tool_done'; record: ToolCallRecord }
  | { type: 'message'; text: string };

export type AgentTurn = {
  turn_id: string;
  mode: AgentMode;
  live: boolean;
  model?: string;
  trigger: 'owner' | 'paypal-event';
  prompt: string;
  text: string;
  tool_calls: ToolCallRecord[];
  model_requests?: number;
  duration_ms: number;
  ok: boolean;
  error?: string;
};

export interface AgentRunner {
  info: AgentInfo;
  ask(prompt: string, opts: { turnId: string; trigger: AgentTurn['trigger']; onEvent: (e: AgentEvent) => void }): Promise<AgentTurn>;
  stop(): Promise<void>;
}
