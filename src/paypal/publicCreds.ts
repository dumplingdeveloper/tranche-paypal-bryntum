// `npm run sandbox:use-public-creds`: writes PayPal's DEFAULT PUBLIC sandbox credentials into the credentials file
// (~/.config/tillwise/paypal-sandbox.env, mode 600) so a judge can try the real sandbox without creating an app.
// They are fetched at run time from PayPal's own Postman collection on GitHub and are never printed, logged or
// stored in this repo. They belong to a SHARED app: anything created with them is visible to other users.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseEnvFile } from './sandboxClient.ts';

export const PUBLIC_COLLECTION_URL = 'https://raw.githubusercontent.com/paypal/postman-collections/main/Collections/PayPal_Public_APIs.json';
// The collection's own variable "PLEASE NOTE -->" says (2026-10-26): "PayPal Public Collection comes with following
// default public set of credentials stored at the Collection level. ..."
const NOTE_KEY = 'PLEASE NOTE -->';
const NOTE_TEXT = 'default public set of credentials';

export type PublicCredsResult =
  | { ok: true; action: 'written' | 'unchanged' | 'dry-run'; file: string; backup?: string; source: string }
  | { ok: false; code: 'FETCH_FAILED' | 'NOT_PUBLIC_SET' | 'FILE_EXISTS'; message: string; file: string };

export async function usePublicSandboxCredentials(opts: { file: string; force?: boolean; dryRun?: boolean; fetchImpl?: typeof fetch; url?: string; now?: () => Date }): Promise<PublicCredsResult> {
  const url = opts.url || PUBLIC_COLLECTION_URL;
  const fetchImpl = opts.fetchImpl || fetch;
  let collection: any;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return { ok: false, code: 'FETCH_FAILED', message: `GET ${url} → HTTP ${res.status}`, file: opts.file };
    collection = await res.json();
  } catch (err) {
    return { ok: false, code: 'FETCH_FAILED', message: `GET ${url} failed: ${(err as Error).name}`, file: opts.file };
  }
  const vars: Array<{ key?: string; value?: unknown }> = Array.isArray(collection?.variable) ? collection.variable : [];
  const value = (k: string) => String(vars.find((v) => v.key === k)?.value ?? '').trim();
  const id = value('client_id');
  const secret = value('client_secret');
  // Only accept the set PayPal itself labels as its default public one, and only plausible-looking values.
  if (!value(NOTE_KEY).includes(NOTE_TEXT) || !/^[A-Za-z0-9_-]{20,200}$/.test(id) || !/^[A-Za-z0-9_-]{20,200}$/.test(secret)) {
    return { ok: false, code: 'NOT_PUBLIC_SET', message: `${url} no longer has a collection-level client_id/client_secret labelled "${NOTE_TEXT}"; nothing was written`, file: opts.file };
  }
  if (opts.dryRun) return { ok: true, action: 'dry-run', file: opts.file, source: url };
  let backup: string | undefined;
  if (existsSync(opts.file)) {
    const current = parseEnvFile(readFileSync(opts.file, 'utf8'));
    if (current.PAYPAL_CLIENT_ID === id && current.PAYPAL_CLIENT_SECRET === secret) return { ok: true, action: 'unchanged', file: opts.file, source: url };
    if (!opts.force) return { ok: false, code: 'FILE_EXISTS', message: `${opts.file} already holds other credentials; rerun with --force to replace them (a .bak copy is kept)`, file: opts.file };
    backup = `${opts.file}.bak`;
    writeFileSync(backup, readFileSync(opts.file), { mode: 0o600 });
    chmodSync(backup, 0o600);
  }
  mkdirSync(dirname(opts.file), { recursive: true, mode: 0o700 });
  const stamp = (opts.now ? opts.now() : new Date()).toISOString();
  const body = [
    "# PayPal's DEFAULT PUBLIC sandbox credentials (a SHARED app: others can see what you create with them).",
    `# Source: ${url} (collection variables client_id / client_secret), fetched ${stamp} by npm run sandbox:use-public-creds.`,
    '# Replace with your own sandbox app from https://developer.paypal.com/dashboard/applications/sandbox when you can.',
    `PAYPAL_CLIENT_ID=${id}`,
    `PAYPAL_CLIENT_SECRET=${secret}`,
    '',
  ].join('\n');
  writeFileSync(opts.file, body, { mode: 0o600 });
  chmodSync(opts.file, 0o600);
  return { ok: true, action: 'written', file: opts.file, backup, source: url };
}
