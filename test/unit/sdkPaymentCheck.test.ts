// Offline contract test for the optional live-mode SDK cross-check. It drives the real @paypal/paypal-server-sdk code
// (OAuth token exchange, request building, response deserialization, typed errors) through the stub axios adapter
// seam that the APIMatic typescript-testing skill documents. No network, no credentials; nothing here proves the
// sandbox accepts these calls (see UNVERIFIED in docs/BUILD_LOG.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '@paypal/paypal-server-sdk';
import { createSdkPaymentCheck } from '../../src/paypal/sdkPaymentCheck.ts';
import { MOCK_INVOICES } from '../../src/domain/mockData.ts';
import type { PayPalInvoice } from '../../src/domain/types.ts';

const TOKEN_PATH = '/v1/oauth2/token'; // oAuthAuthorizationController.ts: createRequest('POST', '/v1/oauth2/token')
const SEARCH_PATH = '/v1/reporting/transactions'; // transactionSearchController.ts: createRequest('GET', '/v1/reporting/transactions')

type Reply = { status: number; body: unknown };
function stub(search: Reply, token: Reply = { status: 200, body: { access_token: 'stub-token', token_type: 'Bearer', expires_in: 3600 } }) {
  const requests: any[] = [];
  const respond = (config: any, r: Reply) => ({ data: typeof r.body === 'string' ? r.body : JSON.stringify(r.body), status: r.status, statusText: '', headers: { 'content-type': 'application/json' }, config });
  const check = createSdkPaymentCheck({
    clientId: 'dummy-client-id',
    clientSecret: 'dummy-client-secret',
    unstableHttpClientOptions: {
      adapter: async (config: any) => {
        requests.push(config);
        return respond(config, String(config.url).includes(TOKEN_PATH) ? token : search);
      },
    },
  });
  return { check, requests };
}

const inv1 = MOCK_INVOICES.find((i) => i.detail.invoice_number === 'INV-1')!; // PAID, PAYPAL tx MOCKTX-ACME-0001 on 2026-10-04
const txInfo = (status: string) => ({ transaction_details: [{ transaction_info: { transaction_id: 'MOCKTX-ACME-0001', transaction_status: status, transaction_amount: { currency_code: 'EUR', value: '3600.00' } } }] });

test('SDK cross-check: OAuth client-credentials token, then GET /v1/reporting/transactions with the invoice payment id; status S → verified', async () => {
  const { check, requests } = stub({ status: 200, body: txInfo('S') });
  const [r] = await check.verifyInvoicePayment(inv1);
  assert.deepEqual(r, {
    invoice_number: 'INV-1', payment_id: 'MOCKTX-ACME-0001', verified: true, transaction_status: 'S',
    amount: { currency_code: 'EUR', value: '3600.00' }, reason: 'completed transaction found',
    via: 'paypal-server-sdk TransactionSearchController.searchTransactions',
  });
  assert.equal(requests.length, 2);
  const [tok, search] = requests;
  assert.equal(tok.method.toUpperCase(), 'POST');
  assert.equal(new URL(tok.url).origin + new URL(tok.url).pathname, `https://api-m.sandbox.paypal.com${TOKEN_PATH}`);
  assert.equal(tok.headers.Authorization ?? tok.headers.authorization, `Basic ${Buffer.from('dummy-client-id:dummy-client-secret').toString('base64')}`);
  assert.equal(search.method.toUpperCase(), 'GET');
  const u = new URL(search.url);
  assert.equal(u.origin + u.pathname, `https://api-m.sandbox.paypal.com${SEARCH_PATH}`);
  assert.deepEqual(Object.fromEntries(u.searchParams), { start_date: '2026-10-03T00:00:00Z', end_date: '2026-10-06T00:00:00Z', transaction_id: 'MOCKTX-ACME-0001', fields: 'transaction_info' });
  assert.equal(search.headers.Authorization ?? search.headers.authorization, 'Bearer stub-token');
});

test('SDK cross-check: reversed (V) or missing transactions are not verified', async () => {
  const reversed = stub({ status: 200, body: txInfo('V') });
  const [v] = await reversed.check.verifyInvoicePayment(inv1);
  assert.equal(v.verified, false);
  assert.equal(v.transaction_status, 'V');
  assert.equal(v.reason, 'transaction status V is not completed');
  const missing = stub({ status: 200, body: { transaction_details: [] } });
  const [m] = await missing.check.verifyInvoicePayment(inv1);
  assert.equal(m.verified, false);
  assert.match(m.reason, /^no transaction with this ID/);
});

test('SDK cross-check: typed SearchError and OAuthProviderError become unverified results, not crashes', async () => {
  const bad = stub({ status: 400, body: { name: 'INVALID_REQUEST', message: 'bad', debug_id: 'dbg123' } });
  const [s] = await bad.check.verifyInvoicePayment(inv1);
  assert.equal(s.verified, false);
  assert.equal(s.reason, 'PayPal search error 400: INVALID_REQUEST (debug_id dbg123)');
  const noAuth = stub({ status: 200, body: txInfo('S') }, { status: 401, body: { error: 'invalid_client', error_description: 'Client Authentication failed' } });
  const [a] = await noAuth.check.verifyInvoicePayment(inv1);
  assert.equal(a.verified, false);
  assert.equal(a.reason, 'PayPal OAuth error 401: invalid_client');
  assert.equal(noAuth.requests.filter((r) => String(r.url).includes(SEARCH_PATH)).length, 0, 'no search without a token');
});

test('SDK cross-check: EXTERNAL (bank transfer) payments are not searched; unpaid invoices make no calls', async () => {
  const external: PayPalInvoice = structuredClone(inv1);
  external.payments!.transactions = [{ payment_date: '2026-10-04', method: 'BANK_TRANSFER', type: 'EXTERNAL' }];
  const { check, requests } = stub({ status: 200, body: txInfo('S') });
  assert.deepEqual(await check.verifyInvoicePayment(external), []);
  assert.deepEqual(await check.verifyInvoicePayment(MOCK_INVOICES.find((i) => i.detail.invoice_number === 'INV-2')!), []);
  assert.equal(requests.length, 0);
});

test('SDK 2.5.0 facts this module relies on: searchTransactions errors are SearchError with result undefined (defaultToError path); root OAuthProviderError is the enum', async () => {
  const client = new sdk.Client({
    environment: sdk.Environment.Sandbox,
    clientCredentialsAuthCredentials: { oAuthClientId: 'dummy', oAuthClientSecret: 'dummy', oAuthToken: { accessToken: 'seeded', tokenType: 'Bearer', expiry: BigInt(Math.floor(Date.now() / 1000) + 3600) } },
    unstable_httpClientOptions: { adapter: async (config: any) => ({ data: JSON.stringify({ name: 'INVALID_REQUEST', debug_id: 'dbg1' }), status: 400, statusText: '', headers: { 'content-type': 'application/json' }, config }) },
  });
  const err: any = await new sdk.TransactionSearchController(client).searchTransactions({ startDate: '2026-10-03T00:00:00Z', endDate: '2026-10-06T00:00:00Z' }).catch((e) => e);
  assert.ok(err instanceof sdk.SearchError);
  assert.equal(err.statusCode, 400);
  assert.equal(err.result, undefined);
  assert.deepEqual(JSON.parse(String(err.body)), { name: 'INVALID_REQUEST', debug_id: 'dbg1' });
  assert.equal(typeof sdk.OAuthProviderError, 'object');
  assert.equal((sdk.OAuthProviderError as any).InvalidClient, 'invalid_client');
});
