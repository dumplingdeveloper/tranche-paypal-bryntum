// `npm start`: mock PayPal + the best available agent (Copilot login → BYOK env → labelled scripted fallback).
// `TRANCHE_PAYPAL=sandbox npm start`: the REST Invoicing v2 sandbox client (credentials from env or
// ~/.config/tillwise/paypal-sandbox.env); without credentials it exits 2 before any PayPal request.
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { createTranche } from './app.ts';
import { ROOT } from './static.ts';
import { CopilotAgent, chooseAgent } from '../agent/copilot.ts';
import { ScriptedAgent } from '../agent/scripted.ts';
import { DEMO_TODAY } from '../domain/mockData.ts';
import type { InvoicingClient } from '../paypal/invoicing.ts';
import { PUBLIC_DEFAULT_APP_ID, sandboxClientFromEnv } from '../paypal/sandboxClient.ts';
import { missingDemoInvoices } from '../paypal/sandboxSeed.ts';

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
  // TRANCHE_PAYPAL is the switch; TRANCHE_PAYPAL_MODE is the older name and still accepted.
  const mode = (process.env.TRANCHE_PAYPAL || process.env.TRANCHE_PAYPAL_MODE || 'mock').toLowerCase();
  if (mode !== 'mock' && mode !== 'sandbox') {
    console.error(`TRANCHE_PAYPAL=${mode} is not supported. Use mock (default) or sandbox.`);
    process.exit(2);
  }
  const today = process.env.TRANCHE_TODAY || DEMO_TODAY;
  let invoicing: InvoicingClient | undefined;
  if (mode === 'sandbox') {
    const { client, lookup } = sandboxClientFromEnv({ today: () => today });
    for (const w of lookup.warnings) console.error(`warning: ${w}`);
    if (!client) {
      console.error(`NO CREDENTIALS: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET, or put them in ${lookup.file} (chmod 600). No request was sent to PayPal.`);
      process.exit(2);
    }
    console.log(`  PayPal credentials: from ${lookup.source} (values not shown)`);
    try {
      const missing = missingDemoInvoices(await client.searchInvoices());
      if (missing.length) {
        console.error(`PayPal sandbox has no ${missing.map((n) => client.prefix + n).join(', ')}. Run \`npm run sandbox:seed\` first.`);
        process.exit(2);
      }
    } catch (err) {
      console.error(`PayPal sandbox check failed: ${client.mask((err as Error).message)}`);
      process.exit(1);
    }
    invoicing = client;
  }
  const loopback = mode === 'sandbox' && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test((invoicing as { baseUrl?: string }).baseUrl || '');
  const pollMs = mode !== 'sandbox' ? undefined : Math.max(loopback ? 5000 : 30000, Number(process.env.TRANCHE_POLL_MS || 30000));
  const preferred = Number(process.env.PORT || 4317);
  if (FORBIDDEN.has(preferred)) throw new Error(`Port ${preferred} is reserved by another local project`);
  const choice = await chooseAgent();
  const app = await createTranche({
    today,
    autoWatch: process.env.TRANCHE_AUTO_AGENT !== '0',
    invoicing,
    // Sandbox has no local webhook receiver, so the watcher polls search-invoices (default every 30 s).
    // The real sandbox is polled at most every 30 s (it may be PayPal's shared public app); only a loopback test stub may go faster.
    pollMs: pollMs,
    auditFile: process.env.TRANCHE_AUDIT_FILE || resolve(ROOT, 'artifacts/runtime/audit.jsonl'),
    agent: (host) => choice.kind === 'llm'
      ? new CopilotAgent(host, { client: choice.client, provider: choice.provider, model: choice.model, auth: choice.auth, today, liveLog: process.env.TRANCHE_LIVE_LOG || resolve(ROOT, 'artifacts/runtime/live-runs.jsonl') })
      : new ScriptedAgent(host, choice.reason),
  });
  const port = await app.listen(await pickPort(preferred));
  const a = app.agent.info;
  console.log(`Tranche running at http://127.0.0.1:${port}/`);
  console.log(mode === 'sandbox'
    ? `  PayPal: ${loopback ? 'SANDBOX API (local stub)' : 'REAL SANDBOX API'} (${(invoicing as { baseUrl?: string }).baseUrl}, app ${(invoicing as { appId?: string }).appId || '?'}${(invoicing as { appId?: string }).appId === PUBLIC_DEFAULT_APP_ID ? " = PayPal's public default sandbox credentials, shared" : ''}, invoices ${(invoicing as { prefix?: string }).prefix}*, polling every ${pollMs! / 1000} s, demo today ${today})`
    : `  PayPal: MOCK (deterministic sandbox-shaped data, demo today ${today})`);
  console.log(`  Agent:  ${a.label}${a.reason ? ` — ${a.reason}` : ''}${a.auth ? ` (${a.auth})` : ''}`);
  const shutdown = async () => { await app.close().catch(() => {}); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => { console.error(`Tranche failed to start: ${(err as Error).message}`); process.exit(1); });
