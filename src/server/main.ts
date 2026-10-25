// `npm start`: mock PayPal + the best available agent (Copilot login → BYOK env → labelled scripted fallback).
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { createTranche } from './app.ts';
import { ROOT } from './static.ts';
import { CopilotAgent, chooseAgent } from '../agent/copilot.ts';
import { ScriptedAgent } from '../agent/scripted.ts';
import { DEMO_TODAY } from '../domain/mockData.ts';

// Ports used by other local projects; never bind them.
const FORBIDDEN = new Set([3337, 3338, 4178, 4179, 4189, 4191, 8097, 8098]);

function portFree(port: number) {
  return new Promise<boolean>((r) => {
    const s = createServer();
    s.once('error', () => r(false));
    s.listen(port, '127.0.0.1', () => s.close(() => r(true)));
  });
}

async function pickPort(preferred: number) {
  for (let p = preferred; p < preferred + 20; p++) if (!FORBIDDEN.has(p) && (await portFree(p))) return p;
  throw new Error(`No free port in ${preferred}..${preferred + 19}`);
}

async function main() {
  const mode = process.env.TRANCHE_PAYPAL_MODE || 'mock';
  if (mode !== 'mock') {
    console.error(`TRANCHE_PAYPAL_MODE=${mode} is not implemented yet (milestone M4: live PayPal sandbox). Use the default mock mode.`);
    process.exit(2);
  }
  const preferred = Number(process.env.PORT || 4317);
  if (FORBIDDEN.has(preferred)) throw new Error(`Port ${preferred} is reserved by another local project`);
  const choice = await chooseAgent();
  const today = process.env.TRANCHE_TODAY || DEMO_TODAY;
  const app = await createTranche({
    today,
    autoWatch: process.env.TRANCHE_AUTO_AGENT !== '0',
    auditFile: process.env.TRANCHE_AUDIT_FILE || resolve(ROOT, 'artifacts/runtime/audit.jsonl'),
    agent: (host) => choice.kind === 'llm'
      ? new CopilotAgent(host, { client: choice.client, provider: choice.provider, model: choice.model, auth: choice.auth, today, liveLog: process.env.TRANCHE_LIVE_LOG || resolve(ROOT, 'artifacts/runtime/live-runs.jsonl') })
      : new ScriptedAgent(host, choice.reason),
  });
  const port = await app.listen(await pickPort(preferred));
  const a = app.agent.info;
  console.log(`Tranche running at http://127.0.0.1:${port}/`);
  console.log(`  PayPal: MOCK (deterministic sandbox-shaped data, demo today ${today})`);
  console.log(`  Agent:  ${a.label}${a.reason ? ` — ${a.reason}` : ''}${a.auth ? ` (${a.auth})` : ''}`);
  const shutdown = async () => { await app.close().catch(() => {}); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => { console.error(`Tranche failed to start: ${(err as Error).message}`); process.exit(1); });
