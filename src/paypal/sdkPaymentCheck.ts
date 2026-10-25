// Optional live-mode cross-check: before the agent may treat a tranche as PAID, confirm that the PayPal transaction
// recorded on the invoice really exists, using the APIMatic-generated @paypal/paypal-server-sdk (2.5.0).
//
// Status: NOT WIRED and NEVER RUN against the PayPal sandbox (no sandbox credentials exist yet). Mock mode does not
// construct it. Only the request/response contract is tested offline (test/unit/sdkPaymentCheck.test.ts) through the
// SDK's documented stub seam. Invoicing itself stays REST: this SDK version has no Invoicing controller.
//
// Written with the APIMatic Context Plugin skills (see docs/BUILD_LOG.md): typescript-client-initialization,
// typescript-authentication, typescript-calling-endpoints, typescript-error-handling, typescript-testing.
import { ApiError, Client, Environment, SearchError, TransactionSearchController } from '@paypal/paypal-server-sdk';
import type { PayPalInvoice } from '../domain/types.ts';

export type PaymentCheck = {
  invoice_number: string;
  payment_id: string;
  verified: boolean;
  // 'S' = completed, 'P' = pending, 'D' = denied, 'V' = reversed/refunded (searchTransactions JSDoc, transactionSearchController.ts)
  transaction_status?: string;
  amount?: { currency_code?: string; value?: string };
  reason: string;
  via: 'paypal-server-sdk TransactionSearchController.searchTransactions';
};

export interface PaymentCrossCheck {
  verifyInvoicePayment(invoice: PayPalInvoice): Promise<PaymentCheck[]>;
}

export type SdkPaymentCheckOptions = {
  clientId: string;
  clientSecret: string;
  environment?: 'sandbox' | 'production';
  // Test seam documented by the typescript-testing skill; production code leaves it undefined.
  unstableHttpClientOptions?: unknown;
};

const DAY = 86_400_000;

function errorPayload(err: ApiError): Record<string, unknown> {
  if (err.result && typeof err.result === 'object') return err.result as Record<string, unknown>;
  if (typeof err.body !== 'string') return {};
  try { const v = JSON.parse(err.body); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function createSdkPaymentCheck(opts: SdkPaymentCheckOptions): PaymentCrossCheck {
  // One flat options object, no builder; credentials property read from src/configuration.ts:29.
  const client = new Client({
    environment: opts.environment === 'production' ? Environment.Production : Environment.Sandbox,
    clientCredentialsAuthCredentials: { oAuthClientId: opts.clientId, oAuthClientSecret: opts.clientSecret },
    timeout: 15_000,
    httpClientOptions: { retryConfig: { maxNumberOfRetries: 0 } },
    ...(opts.unstableHttpClientOptions ? { unstable_httpClientOptions: opts.unstableHttpClientOptions } : {}),
  });
  const search = new TransactionSearchController(client);

  async function checkOne(invoiceNumber: string, paymentId: string, paymentDate: string): Promise<PaymentCheck> {
    const base = { invoice_number: invoiceNumber, payment_id: paymentId, via: 'paypal-server-sdk TransactionSearchController.searchTransactions' as const };
    const day = Date.parse(`${paymentDate}T00:00:00Z`);
    try {
      // The window must be <= 31 days and seconds are required (searchTransactions JSDoc).
      const res = await search.searchTransactions({
        startDate: isoSeconds(day - DAY),
        endDate: isoSeconds(day + 2 * DAY),
        transactionId: paymentId,
        fields: 'transaction_info',
      });
      const infos = (res.result.transactionDetails || []).map((d) => d.transactionInfo).filter((i) => i?.transactionId === paymentId);
      if (!infos.length) return { ...base, verified: false, reason: 'no transaction with this ID in the search window (PayPal may take up to 3 hours to list it)' };
      // The reporting system can list the same ID twice (balance-affecting or not); any completed record counts.
      const done = infos.find((i) => i!.transactionStatus === 'S');
      const pick = done || infos[0]!;
      return {
        ...base,
        verified: Boolean(done),
        transaction_status: pick.transactionStatus,
        amount: pick.transactionAmount ? { currency_code: pick.transactionAmount.currencyCode, value: pick.transactionAmount.value } : undefined,
        reason: done ? 'completed transaction found' : `transaction status ${pick.transactionStatus ?? 'unknown'} is not completed`,
      };
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      // Error payloads keep the wire field names (debug_id, error), per typescript-error-handling. Two SDK 2.5.0
      // details found while testing (docs/BUILD_LOG.md): searchTransactions maps errors via defaultToError, and that
      // path never parses the body, so SearchError.result stays undefined -> read the raw body. And the root export
      // `OAuthProviderError` is the model enum (src/index.ts:183), not the error class, so token errors are recognised
      // by their OAuth payload instead of instanceof.
      const p = errorPayload(err);
      if (typeof p.error === 'string') return { ...base, verified: false, reason: `PayPal OAuth error ${err.statusCode}: ${p.error}` };
      if (err instanceof SearchError) return { ...base, verified: false, reason: `PayPal search error ${err.statusCode}: ${p.name ?? 'unknown'} (debug_id ${p.debug_id ?? 'n/a'})` };
      return { ...base, verified: false, reason: `PayPal HTTP ${err.statusCode}` };
    }
  }

  return {
    async verifyInvoicePayment(invoice) {
      const txs = (invoice.payments?.transactions || []).filter((t) => t.type === 'PAYPAL' && t.payment_id);
      // EXTERNAL payments (bank transfer, cash) are recorded by the merchant and never appear in Transaction Search.
      return Promise.all(txs.map((t) => checkOne(invoice.detail.invoice_number, t.payment_id!, t.payment_date)));
    },
  };
}
