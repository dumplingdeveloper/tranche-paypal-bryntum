// `npm run sandbox:seed [-- --fresh]`: creates/advances the demo invoices in the PayPal sandbox (idempotent).
// Every set gets its own invoice-number prefix (e.g. TR-K3F9Q-), saved in .tranche/sandbox-state.json, so sets seeded
// with PayPal's shared public sandbox app never collide; `--fresh` starts a new set (the old one is left as it is).
// Exit 2 with "NO CREDENTIALS" and no network call when credentials are missing.
import { DEMO_TODAY } from '../src/domain/mockData.ts';
import { PUBLIC_DEFAULT_APP_ID, SANDBOX_STATE_FILE, invoicePrefixFromEnv, newDemoPrefix, readSandboxState, sandboxClientFromEnv, writeSandboxState } from '../src/paypal/sandboxClient.ts';
import { seedSandbox } from '../src/paypal/sandboxSeed.ts';

const fresh = process.argv.includes('--fresh');
const stateFile = process.env.TRANCHE_SANDBOX_STATE || SANDBOX_STATE_FILE;
const saved = readSandboxState(stateFile);
const prefix = process.env.TRANCHE_INVOICE_PREFIX ? invoicePrefixFromEnv() : (!fresh && saved?.prefix) || newDemoPrefix();
const { client, lookup } = sandboxClientFromEnv({ prefix });
for (const w of lookup.warnings) console.error(`warning: ${w}`);
if (!client) {
  console.error(`NO CREDENTIALS: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET, or create ${lookup.file} (chmod 600). Nothing was sent to PayPal.`);
  process.exit(2);
}
const demoToday = process.env.TRANCHE_TODAY || DEMO_TODAY;
if (!process.env.TRANCHE_INVOICE_PREFIX) writeSandboxState({ prefix, created_at: saved?.prefix === prefix ? saved.created_at : new Date().toISOString(), base_url: client.baseUrl }, stateFile);
console.log(`Seeding ${client.baseUrl} (credentials from ${lookup.source}; values not shown), prefix ${prefix}${saved?.prefix === prefix ? ' (saved set)' : ' (new set)'}, demo clock ${demoToday}`);
try {
  const rows = await seedSandbox(client, { demoToday });
  if (!process.env.TRANCHE_INVOICE_PREFIX) writeSandboxState({ ...readSandboxState(stateFile)!, app_id: client.appId }, stateFile);
  console.table(rows.map((r) => ({ number: `${client.prefix}${r.invoice_number}`, id: r.id, target: r.target, status: r.status, due: r.due_date, overdue_days_on_demo_clock: r.days_overdue_on_demo_clock, paid: r.paid_date || '', actions: r.actions.join(' → ') })));
  for (const r of rows) if (r.note) console.log(`note ${r.invoice_number}: ${r.note}`);
  console.log(`PayPal app: ${client.appId || 'unknown'}${client.appId === PUBLIC_DEFAULT_APP_ID ? " — PayPal's default PUBLIC sandbox credentials: a shared app, other people can see these invoices" : ''}`);
  console.log(`Overdue is derived from due_date and the demo clock (TRANCHE_TODAY, default ${DEMO_TODAY}); PayPal has no OVERDUE status.`);
  console.log(`PayPal requests sent: ${client.requestCount}`);
  console.log(`Next: TRANCHE_PAYPAL=sandbox npm start`);
} catch (err) {
  console.error(`sandbox:seed failed: ${client.mask((err as Error).message)} (PayPal requests sent: ${client.requestCount})`);
  process.exit(1);
}
