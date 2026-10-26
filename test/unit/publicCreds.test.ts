// sandbox:use-public-creds against an injected fetch (no network). The values below are fake test strings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PUBLIC_COLLECTION_URL, usePublicSandboxCredentials } from '../../src/paypal/publicCreds.ts';
import { loadSandboxCredentials } from '../../src/paypal/sandboxClient.ts';

const ID = 'AfakePublicClientId_0123456789abcdef';
const SECRET = 'EfakePublicSecret_0123456789abcdefgh';
const NOTE = '< PayPal Public Collection comes with following default public set of credentials stored at the Collection level. \nYou may choose to override these values via environment level variables.';
const collection = (vars: Record<string, string>) => ({ info: {}, variable: Object.entries(vars).map(([key, value]) => ({ key, value })) });
const fakeFetch = (body: unknown, status = 200) => {
  const urls: string[] = [];
  const f = (async (url: string) => { urls.push(String(url)); return new Response(JSON.stringify(body), { status }); }) as unknown as typeof fetch;
  return { f, urls };
};
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'tranche-pubcreds-')), 'sub', 'paypal-sandbox.env');

test('writes the collection-level client_id/client_secret to the credentials file (mode 600) from PayPal\'s collection URL', async () => {
  const file = tmpFile();
  const { f, urls } = fakeFetch(collection({ 'PLEASE NOTE -->': NOTE, client_id: ID, client_secret: SECRET }));
  const r = await usePublicSandboxCredentials({ file, fetchImpl: f });
  assert.deepEqual(urls, [PUBLIC_COLLECTION_URL]);
  assert.equal(PUBLIC_COLLECTION_URL, 'https://raw.githubusercontent.com/paypal/postman-collections/main/Collections/PayPal_Public_APIs.json');
  assert.deepEqual(r, { ok: true, action: 'written', file, backup: undefined, source: PUBLIC_COLLECTION_URL });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const lookup = loadSandboxCredentials({}, file);
  assert.deepEqual([lookup.source, lookup.creds, lookup.warnings], ['file', { clientId: ID, clientSecret: SECRET }, []]);
  assert.ok(readFileSync(file, 'utf8').includes('SHARED app'));
  // Second run: identical values → unchanged, no backup.
  assert.equal((await usePublicSandboxCredentials({ file, fetchImpl: f }) as any).action, 'unchanged');
  assert.equal(existsSync(`${file}.bak`), false);
});

test('never overwrites other credentials without --force; with force keeps a mode-600 .bak; results never contain the values', async () => {
  const file = tmpFile();
  await usePublicSandboxCredentials({ file, fetchImpl: fakeFetch(collection({ 'PLEASE NOTE -->': NOTE, client_id: ID, client_secret: SECRET })).f });
  writeFileSync(file, 'PAYPAL_CLIENT_ID=MyOwnAppClientId_abcdefghijklmnop\nPAYPAL_CLIENT_SECRET=MyOwnAppSecret_abcdefghijklmnopq\n', { mode: 0o600 });
  const { f } = fakeFetch(collection({ 'PLEASE NOTE -->': NOTE, client_id: ID, client_secret: SECRET }));
  const refused = await usePublicSandboxCredentials({ file, fetchImpl: f });
  assert.equal(refused.ok, false);
  assert.equal((refused as any).code, 'FILE_EXISTS');
  assert.ok(readFileSync(file, 'utf8').includes('MyOwnAppClientId'));
  const forced = await usePublicSandboxCredentials({ file, fetchImpl: f, force: true });
  assert.equal((forced as any).backup, `${file}.bak`);
  assert.equal(statSync(`${file}.bak`).mode & 0o777, 0o600);
  assert.ok(readFileSync(`${file}.bak`, 'utf8').includes('MyOwnAppClientId'));
  for (const r of [refused, forced]) assert.ok(!JSON.stringify(r).includes(ID) && !JSON.stringify(r).includes(SECRET));
});

test('refuses (writes nothing) when the PayPal note is missing, values look wrong, or the fetch fails; --dry-run writes nothing', async () => {
  for (const [body, status, code] of [
    [collection({ client_id: ID, client_secret: SECRET }), 200, 'NOT_PUBLIC_SET'],
    [collection({ 'PLEASE NOTE -->': NOTE, client_id: '{{client_id}}', client_secret: SECRET }), 200, 'NOT_PUBLIC_SET'],
    [{}, 404, 'FETCH_FAILED'],
  ] as const) {
    const file = tmpFile();
    const r = await usePublicSandboxCredentials({ file, fetchImpl: fakeFetch(body, status).f });
    assert.equal((r as any).code, code);
    assert.equal(existsSync(file), false);
  }
  const file = tmpFile();
  const dry = await usePublicSandboxCredentials({ file, dryRun: true, fetchImpl: fakeFetch(collection({ 'PLEASE NOTE -->': NOTE, client_id: ID, client_secret: SECRET })).f });
  assert.equal((dry as any).action, 'dry-run');
  assert.equal(existsSync(file), false);
});
