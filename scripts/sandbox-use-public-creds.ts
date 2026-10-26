// `npm run sandbox:use-public-creds [-- --force] [-- --dry-run]` — see src/paypal/publicCreds.ts. Never prints the values.
// `--file=<path>` writes somewhere else (testing only: the app reads ~/.config/tillwise/paypal-sandbox.env).
import { CREDENTIALS_FILE } from '../src/paypal/sandboxClient.ts';
import { usePublicSandboxCredentials } from '../src/paypal/publicCreds.ts';

const file = process.argv.find((a) => a.startsWith('--file='))?.slice('--file='.length) || CREDENTIALS_FILE;
const r = await usePublicSandboxCredentials({ file, force: process.argv.includes('--force'), dryRun: process.argv.includes('--dry-run') });
if (!r.ok) {
  console.error(`sandbox:use-public-creds: ${r.code}: ${r.message}`);
  process.exit(r.code === 'FILE_EXISTS' ? 3 : 1);
}
const what = { written: 'written', unchanged: 'already present, file unchanged', 'dry-run': 'found and validated (dry run, nothing written)' }[r.action];
console.log(`PayPal default PUBLIC sandbox credentials ${what}: ${r.file} (mode 600; values not shown)${r.backup ? `; previous file kept as ${r.backup}` : ''}`);
console.log(`Source: ${r.source} (collection variables client_id / client_secret)`);
console.log('This is a SHARED sandbox app: anything you create with it is visible to other users of these credentials.');
console.log('Next: npm run sandbox:seed && TRANCHE_PAYPAL=sandbox npm start');
