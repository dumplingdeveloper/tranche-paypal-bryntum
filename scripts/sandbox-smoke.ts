// `npm run sandbox:smoke`: read-only checks against YOUR PayPal sandbox plus one draft invoice that is deleted again.
// Exit 2 with "NO CREDENTIALS" and no network call when credentials are missing.
import { sandboxClientFromEnv } from '../src/paypal/sandboxClient.ts';
import { smokeSandbox } from '../src/paypal/sandboxSeed.ts';

const { client, lookup } = sandboxClientFromEnv();
for (const w of lookup.warnings) console.error(`warning: ${w}`);
if (!client) {
  console.error(`NO CREDENTIALS: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET, or create ${lookup.file} (chmod 600). Nothing was sent to PayPal.`);
  process.exit(2);
}
console.log(`Smoke test against ${client.baseUrl} (credentials from ${lookup.source}; values not shown)`);
try {
  const steps = await smokeSandbox(client);
  for (const s of steps) console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.step}: ${s.detail}`);
  const failed = steps.filter((s) => !s.ok).length;
  console.log(failed ? `sandbox:smoke: ${failed} check(s) failed` : `sandbox:smoke: all ${steps.length} checks passed`);
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error(`sandbox:smoke failed: ${client.mask((err as Error).message)}`);
  process.exit(1);
}
