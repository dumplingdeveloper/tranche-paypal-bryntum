// `npm run sandbox:seed`: creates/advances the demo invoices in YOUR PayPal sandbox (idempotent, TRANCHE- numbers,
// reference "tranche-demo/v1"). Exit 2 with "NO CREDENTIALS" and no network call when credentials are missing.
import { DEMO_TODAY } from '../src/domain/mockData.ts';
import { sandboxClientFromEnv } from '../src/paypal/sandboxClient.ts';
import { seedSandbox } from '../src/paypal/sandboxSeed.ts';

const { client, lookup } = sandboxClientFromEnv();
for (const w of lookup.warnings) console.error(`warning: ${w}`);
if (!client) {
  console.error(`NO CREDENTIALS: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET, or create ${lookup.file} (chmod 600). Nothing was sent to PayPal.`);
  process.exit(2);
}
const demoToday = process.env.TRANCHE_TODAY || DEMO_TODAY;
console.log(`Seeding ${client.baseUrl} (credentials from ${lookup.source}; values not shown), prefix ${client.prefix}, demo clock ${demoToday}`);
try {
  const rows = await seedSandbox(client, { demoToday });
  console.table(rows.map((r) => ({ number: `${client.prefix}${r.invoice_number}`, id: r.id, target: r.target, status: r.status, due: r.due_date, overdue_days_on_demo_clock: r.days_overdue_on_demo_clock, paid: r.paid_date || '', actions: r.actions.join(' → ') })));
  for (const r of rows) if (r.note) console.log(`note ${r.invoice_number}: ${r.note}`);
  console.log(`Overdue is derived from due_date and the demo clock (TRANCHE_TODAY, default ${DEMO_TODAY}); PayPal has no OVERDUE status.`);
  console.log(`Next: TRANCHE_PAYPAL=sandbox npm start`);
} catch (err) {
  console.error(`sandbox:seed failed: ${client.mask((err as Error).message)}`);
  process.exit(1);
}
