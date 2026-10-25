// Live PayPal Invoicing v2 client for the SANDBOX only (TRANCHE_PAYPAL=sandbox). Written fresh for Tranche.
// Endpoint and field names come from PayPal's OpenAPI spec invoicing_v2.json ("INV:<line>") and the OAuth docs;
// see docs/FACTS_PAYPAL_INVOICING.md §"Sandbox client". Status: unit-tested against a local stub server only; it has
// NOT been run against the real sandbox yet (no credentials).
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { InvoiceStatus, Money, PayPalInvoice } from '../domain/types.ts';
import { InvoicingError, type InvoicingCall, type InvoiceNotification, type InvoiceSearch, type InvoicingClient, type PaymentDetail, type RefundDetail } from './invoicing.ts';

export const SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com'; // INV:11 (servers[0])
export const CREDENTIALS_FILE = join(homedir(), '.config', 'tillwise', 'paypal-sandbox.env');
/** Prefix on PayPal invoice numbers so Tranche never touches other invoices in a shared sandbox account. */
export const INVOICE_PREFIX = 'TRANCHE-';
/** `detail.reference` tag (INV:3116, max 120 chars) written by `npm run sandbox:seed`. */
export const SEED_REFERENCE = 'tranche-demo/v1';

export type SandboxCredentials = { clientId: string; clientSecret: string };
export type CredentialLookup = { creds?: SandboxCredentials; source: 'env' | 'file' | 'env+file' | 'none'; file: string; warnings: string[] };

function parseEnvFile(text: string) {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** Env vars PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET override the file. Never returns or logs values elsewhere. */
export function loadSandboxCredentials(env: NodeJS.ProcessEnv = process.env, file = CREDENTIALS_FILE): CredentialLookup {
  const warnings: string[] = [];
  let fromFile: Record<string, string> = {};
  try {
    const st = statSync(file);
    if ((st.mode & 0o077) !== 0) warnings.push(`${file} is readable by other users (mode ${(st.mode & 0o777).toString(8)}); run: chmod 600 ${file}`);
    fromFile = parseEnvFile(readFileSync(file, 'utf8'));
  } catch { /* absent file is the normal "no credentials" case */ }
  const id = env.PAYPAL_CLIENT_ID || fromFile.PAYPAL_CLIENT_ID || '';
  const secret = env.PAYPAL_CLIENT_SECRET || fromFile.PAYPAL_CLIENT_SECRET || '';
  const usedEnv = Boolean(env.PAYPAL_CLIENT_ID || env.PAYPAL_CLIENT_SECRET);
  const usedFile = Boolean((!env.PAYPAL_CLIENT_ID && fromFile.PAYPAL_CLIENT_ID) || (!env.PAYPAL_CLIENT_SECRET && fromFile.PAYPAL_CLIENT_SECRET));
  if (!id || !secret) return { source: 'none', file, warnings };
  return { creds: { clientId: id, clientSecret: secret }, source: usedEnv && usedFile ? 'env+file' : usedEnv ? 'env' : 'file', file, warnings };
}

const KNOWN_STATUSES = new Set<InvoiceStatus>(['DRAFT', 'SENT', 'SCHEDULED', 'PAID', 'MARKED_AS_PAID', 'CANCELLED', 'REFUNDED', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED', 'MARKED_AS_REFUNDED', 'UNPAID', 'PAYMENT_PENDING', 'AUTO_CANCELLED', 'PAID_EXTERNAL', 'REFUNDED_EXTERNAL', 'SHARED']); // INV:3868-3958

/**
 * PayPal status → Tranche domain status. The domain keeps PayPal's own enum (src/domain/schedule.ts decides what is
 * paid / blocking). Unknown future values are treated as UNPAID: money still expected, so the next phase stays blocked.
 */
export function toDomainStatus(raw: unknown): { status: InvoiceStatus; unknown?: string } {
  const s = String(raw || '');
  return KNOWN_STATUSES.has(s as InvoiceStatus) ? { status: s as InvoiceStatus } : { status: 'UNPAID', unknown: s };
}

const DUE_TAG = /\bdue=(\d{4}-\d{2}-\d{2})\b/;

/** Map a PayPal `invoice` (INV:3671) to the subset Tranche uses. Overdue is derived later from the due date. */
export function toDomainInvoice(raw: any, prefix = INVOICE_PREFIX): PayPalInvoice {
  const d = raw?.detail || {};
  const number = String(d.invoice_number || '');
  const { status } = toDomainStatus(raw?.status);
  const invoiceDate = String(d.invoice_date || d.metadata?.create_time || '').slice(0, 10);
  // due_date (INV:3860); when PayPal holds no date (e.g. DUE_ON_RECEIPT) fall back to the seed's reference tag, then
  // to the invoice date (due on receipt).
  const due = String(d.payment_term?.due_date || DUE_TAG.exec(String(d.reference || ''))?.[1] || invoiceDate).slice(0, 10);
  const recipient = raw?.primary_recipients?.[0]?.billing_info || {};
  const name = recipient.business_name || [recipient.name?.given_name, recipient.name?.surname].filter(Boolean).join(' ') || recipient.email_address || '';
  const amount: Money = raw?.amount?.value ? { currency_code: raw.amount.currency_code, value: String(raw.amount.value) } : { currency_code: d.currency_code || 'EUR', value: '0.00' };
  const inv: PayPalInvoice = {
    id: String(raw?.id || ''),
    status,
    detail: {
      invoice_number: number.startsWith(prefix) ? number.slice(prefix.length) : number,
      currency_code: String(d.currency_code || amount.currency_code),
      invoice_date: invoiceDate,
      ...(d.note ? { note: String(d.note) } : {}),
      payment_term: { term_type: String(d.payment_term?.term_type || (d.payment_term?.due_date ? 'DUE_ON_DATE_SPECIFIED' : 'DUE_ON_RECEIPT')), due_date: due },
    },
    primary_recipients: [{ billing_info: { business_name: String(name), email_address: String(recipient.email_address || '') } }],
    amount,
  };
  const tx = (list: any[] | undefined, kind: 'payment' | 'refund') => (list || []).map((t) => ({
    ...(kind === 'payment' ? { payment_id: t.payment_id } : { refund_id: t.refund_id }),
    [`${kind}_date`]: String(t[`${kind}_date`] || '').slice(0, 10), method: String(t.method || 'OTHER'), type: t.type === 'PAYPAL' ? 'PAYPAL' : 'EXTERNAL',
    ...(t.amount ? { amount: t.amount } : {}), ...(t.note ? { note: t.note } : {}),
  }));
  if (raw?.payments) inv.payments = { paid_amount: raw.payments.paid_amount || { currency_code: amount.currency_code, value: '0.00' }, transactions: tx(raw.payments.transactions, 'payment') as any };
  if (raw?.refunds) inv.refunds = { refund_amount: raw.refunds.refund_amount || { currency_code: amount.currency_code, value: '0.00' }, transactions: tx(raw.refunds.transactions, 'refund') as any };
  return inv;
}

export type DraftInput = {
  invoice_number: string; // domain number, e.g. INV-2 (sent to PayPal as TRANCHE-INV-2)
  invoice_date: string;
  due_date?: string;
  reference?: string;
  note?: string;
  recipient: { business_name: string; email_address: string };
  item: { name: string; amount: Money };
};

export type SandboxClientOptions = {
  credentials: SandboxCredentials;
  baseUrl?: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  today?: () => string;
  maxRetries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  prefix?: string;
};

const RETRY_STATUS = (s: number) => s === 429 || s >= 500;

export class SandboxInvoicingClient implements InvoicingClient {
  readonly mode = 'sandbox' as const;
  readonly calls: InvoicingCall[] = [];
  readonly baseUrl: string;
  private creds: SandboxCredentials;
  private fetchImpl: typeof fetch;
  private logLine: (line: string) => void;
  private today: () => string;
  private maxRetries: number;
  private baseDelayMs: number;
  private sleep: (ms: number) => Promise<void>;
  readonly prefix: string;
  private token?: { value: string; expiresAt: number };
  private tokenPromise?: Promise<string>;

  constructor(o: SandboxClientOptions) {
    if (!o.credentials?.clientId || !o.credentials?.clientSecret) throw new InvoicingError(0, 'NO_CREDENTIALS', 'NO CREDENTIALS: PayPal sandbox client needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET');
    const base = (o.baseUrl || SANDBOX_BASE_URL).replace(/\/+$/, '');
    const host = new URL(base).hostname;
    // Sandbox only; loopback is allowed for the stub-server tests. Never the live host api-m.paypal.com.
    if (base !== SANDBOX_BASE_URL && host !== '127.0.0.1' && host !== 'localhost') throw new Error(`Refusing PayPal base URL ${base}: Tranche only talks to ${SANDBOX_BASE_URL}`);
    this.baseUrl = base;
    this.creds = o.credentials;
    this.fetchImpl = o.fetch || globalThis.fetch;
    this.logLine = o.log || ((l) => console.error(l));
    this.today = o.today || (() => new Date().toISOString().slice(0, 10));
    this.maxRetries = o.maxRetries ?? 3;
    this.baseDelayMs = o.baseDelayMs ?? 500;
    this.sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.prefix = o.prefix ?? INVOICE_PREFIX;
  }

  /** Replace any credential or token value in a string before it is logged or thrown. */
  mask(text: string) {
    let out = String(text);
    for (const s of [this.creds.clientSecret, this.creds.clientId, this.token?.value]) if (s && s.length >= 4) out = out.split(s).join('***');
    return out;
  }

  private log(line: string) { this.logLine(this.mask(line)); }

  // OAuth2 client_credentials: POST /v1/oauth2/token (INV:2557 tokenUrl), HTTP Basic client_id:secret. Cached until
  // 60 s before `expires_in` runs out; concurrent callers share one request.
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    if (!this.tokenPromise) {
      this.tokenPromise = (async () => {
        const basic = Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString('base64');
        const res = await this.send('POST', '/v1/oauth2/token', {
          headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: 'grant_type=client_credentials',
        }, true);
        const body = await res.json().catch(() => ({})) as any;
        if (!body.access_token) throw new InvoicingError(502, 'TOKEN_MISSING', 'PayPal token response had no access_token');
        const ttl = Math.max(0, Number(body.expires_in || 0) - 60) * 1000;
        this.token = { value: String(body.access_token), expiresAt: Date.now() + ttl };
        return this.token.value;
      })().finally(() => { this.tokenPromise = undefined; });
    }
    return this.tokenPromise;
  }

  // One HTTP exchange with retry/backoff on 429 and 5xx (and network errors) for `retryable` calls.
  private async send(method: string, path: string, init: { headers: Record<string, string>; body?: string }, retryable: boolean): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      let netErr: Error | undefined;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers: init.headers, body: init.body });
      } catch (err) { netErr = err as Error; }
      const status = res?.status ?? 0;
      if (res && res.ok) return res;
      const canRetry = (retryable || status === 429) && attempt < this.maxRetries && (netErr || RETRY_STATUS(status));
      if (canRetry) {
        const after = Number(res?.headers.get('retry-after'));
        const delay = Number.isFinite(after) && after > 0 ? after * 1000 : this.baseDelayMs * 2 ** attempt;
        this.log(`PayPal ${method} ${path} → ${netErr ? `network error ${netErr.message}` : status}; retry ${attempt + 1}/${this.maxRetries} in ${delay} ms${res ? ` (PayPal-Debug-Id ${res.headers.get('paypal-debug-id') || 'n/a'})` : ''}`);
        await this.sleep(delay);
        continue;
      }
      if (netErr) throw new InvoicingError(0, 'NETWORK_ERROR', this.mask(`PayPal ${method} ${path} failed: ${netErr.message}`));
      throw await this.toError(method, path, res!);
    }
  }

  // PayPal error body (INV:3506 error_default → name, message, debug_id INV:3206, details[].issue/description).
  private async toError(method: string, path: string, res: Response) {
    const text = await res.text().catch(() => '');
    let body: any = {};
    try { body = JSON.parse(text); } catch { /* non-JSON */ }
    const debugId = res.headers.get('paypal-debug-id') || body.debug_id || 'n/a';
    const detail = body.details?.[0];
    const issue = String(detail?.issue || body.name || body.error || `HTTP_${res.status}`);
    const message = this.mask(`PayPal ${method} ${path} → ${res.status} ${issue}: ${detail?.description || body.message || body.error_description || text.slice(0, 200)} (PayPal-Debug-Id ${debugId})`);
    this.log(message);
    const err = new InvoicingError(res.status, issue, message);
    (err as any).debugId = debugId;
    return err;
  }

  private async api(method: string, path: string, body?: unknown, opts: { retryable?: boolean; prefer?: boolean } = {}) {
    const run = async () => {
      const token = await this.accessToken();
      return this.send(method, path, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(opts.prefer ? { prefer: 'return=representation' } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, opts.retryable ?? method === 'GET');
    };
    try {
      return await run();
    } catch (err) {
      // An expired/revoked token: fetch a new one once.
      if (err instanceof InvoicingError && err.status === 401 && !path.startsWith('/v1/oauth2')) { this.token = undefined; return run(); }
      throw err;
    }
  }

  private async json(res: Response) {
    if (res.status === 204) return undefined;
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  }

  private record(op: string, invoice_id: string, detail?: unknown) {
    this.calls.push({ op, invoice_id, at: this.today(), ...(detail === undefined ? {} : { detail }) });
  }

  remindersOn(invoiceId: string, day = this.today()) {
    return this.calls.filter((c) => c.op === 'remind' && c.invoice_id === invoiceId && c.at === day).length;
  }

  /** POST /v2/invoicing/search-invoices (INV:1767, body search_data INV:6762), all pages; only TRANCHE- invoices. */
  async searchInvoices(query: InvoiceSearch & { invoice_number?: string } = {}): Promise<PayPalInvoice[]> {
    const body: Record<string, unknown> = {};
    if (query.status?.length) body.status = query.status;
    if (query.invoice_number) body.invoice_number = `${this.prefix}${query.invoice_number}`;
    const out: PayPalInvoice[] = [];
    for (let page = 1; page <= 20; page++) {
      const res = await this.api('POST', `/v2/invoicing/search-invoices?page=${page}&page_size=100&total_required=true`, body, { retryable: true });
      const data = await this.json(res) as { items?: unknown[]; total_pages?: number } | undefined;
      for (const raw of data?.items || []) {
        const n = String((raw as any)?.detail?.invoice_number || '');
        if (n.startsWith(this.prefix)) out.push(toDomainInvoice(raw, this.prefix));
      }
      if (!data?.total_pages || page >= data.total_pages) break;
    }
    return out;
  }

  /** GET /v2/invoicing/invoices (INV:230 "List invoices"; page/page_size/total_required INV:315-321). One page, TRANCHE- only. */
  async listInvoices(page = 1, pageSize = 100): Promise<{ invoices: PayPalInvoice[]; total_pages?: number }> {
    const res = await this.api('GET', `/v2/invoicing/invoices?page=${page}&page_size=${pageSize}&total_required=true`);
    const data = await this.json(res) as { items?: any[]; total_pages?: number } | undefined;
    const invoices = (data?.items || []).filter((raw) => String(raw?.detail?.invoice_number || '').startsWith(this.prefix)).map((raw) => toDomainInvoice(raw, this.prefix));
    return { invoices, total_pages: data?.total_pages };
  }

  /** GET /v2/invoicing/invoices/{invoice_id} (INV:1440). Also accepts a domain number such as INV-2. */
  async getInvoice(invoiceId: string): Promise<PayPalInvoice> {
    if (!/^INV2-/.test(invoiceId)) {
      const hit = (await this.searchInvoices({ invoice_number: invoiceId })).find((i) => i.detail.invoice_number === invoiceId);
      if (!hit) throw new InvoicingError(404, 'RESOURCE_NOT_FOUND', `Invoice ${invoiceId} not found in the sandbox`);
      return hit;
    }
    const res = await this.api('GET', `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`);
    return toDomainInvoice(await this.json(res), this.prefix);
  }

  /** POST /v2/invoicing/invoices (INV:97) with `Prefer: return=representation` (INV:104). Creates a DRAFT. */
  async createDraft(input: DraftInput): Promise<PayPalInvoice> {
    const body = {
      detail: {
        invoice_number: `${this.prefix}${input.invoice_number}`,
        reference: input.reference ?? SEED_REFERENCE,
        currency_code: input.item.amount.currency_code,
        invoice_date: input.invoice_date,
        ...(input.note ? { note: input.note } : {}),
        payment_term: input.due_date ? { due_date: input.due_date } : { term_type: 'DUE_ON_RECEIPT' },
      },
      primary_recipients: [{ billing_info: { business_name: input.recipient.business_name, email_address: input.recipient.email_address } }],
      items: [{ name: input.item.name, quantity: '1', unit_amount: input.item.amount }],
    };
    const res = await this.api('POST', '/v2/invoicing/invoices', body, { prefer: true, retryable: false });
    const data = await this.json(res) as any;
    // Without the representation PayPal returns a link (INV:104); fall back to GET on its href.
    const raw = data?.id ? data : data?.href ? await this.json(await this.api('GET', new URL(data.href).pathname)) : data;
    const inv = toDomainInvoice(raw, this.prefix);
    this.record('create_draft', inv.id, { invoice_number: input.invoice_number });
    return inv;
  }

  /** DELETE /v2/invoicing/invoices/{invoice_id} (INV:1694-1696): "Deletes invoices in the draft or scheduled state only". Used by sandbox:smoke cleanup. */
  async deleteDraft(invoiceId: string) {
    await this.api('DELETE', `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`, undefined, { retryable: false });
    this.record('delete_draft', invoiceId);
  }

  /** POST …/send (INV:337), body `notification` (INV:6291). */
  async sendInvoice(invoiceId: string, notification: InvoiceNotification = { send_to_recipient: true }) {
    await this.api('POST', `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/send`, notification, { retryable: false });
    this.record('send', invoiceId, notification);
  }

  /** POST …/remind (INV:477); 204 No Content. PayPal allows only 2 reminders a day (INV:480). */
  async remindInvoice(invoiceId: string, notification: InvoiceNotification = { send_to_recipient: true }) {
    await this.api('POST', `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/remind`, notification, { retryable: false });
    this.record('remind', invoiceId, notification);
  }

  /** POST …/cancel (INV:632); 204 No Content. */
  async cancelInvoice(invoiceId: string, notification: InvoiceNotification = { send_to_recipient: false }) {
    await this.api('POST', `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/cancel`, notification, { retryable: false });
    this.record('cancel', invoiceId, notification);
  }

  /** POST …/payments (INV:742), body `payment_detail` (INV:6341; `method` required) → `payment_reference` (INV:6446). */
  async recordPayment(invoiceId: string, payment: PaymentDetail) {
    const res = await this.api('POST', `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/payments`, payment, { retryable: false });
    const data = await this.json(res) as { payment_id?: string } | undefined;
    const payment_id = String(data?.payment_id || '');
    this.record('record_payment', invoiceId, { payment_id, method: payment.method });
    return { payment_id };
  }

  /** POST …/refunds (INV:1005), body `refund_detail` (INV:6682) → `refund_reference` (INV:6725). */
  async recordRefund(invoiceId: string, refund: RefundDetail) {
    const res = await this.api('POST', `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/refunds`, refund, { retryable: false });
    const data = await this.json(res) as { refund_id?: string } | undefined;
    const refund_id = String(data?.refund_id || '');
    this.record('record_refund', invoiceId, { refund_id });
    return { refund_id };
  }
}

/** Builds the sandbox client only when credentials exist; otherwise returns the reason and makes no request. */
export function sandboxClientFromEnv(opts: Omit<SandboxClientOptions, 'credentials'> & { env?: NodeJS.ProcessEnv; file?: string } = {}) {
  const env = opts.env || process.env;
  const lookup = loadSandboxCredentials(env, opts.file);
  if (!lookup.creds) return { client: undefined, lookup };
  return { client: new SandboxInvoicingClient({ ...opts, prefix: opts.prefix ?? invoicePrefixFromEnv(env), credentials: lookup.creds }), lookup };
}

/** TRANCHE_INVOICE_PREFIX (default TRANCHE-) lets a judge seed a fresh demo set; invoice_number is max 25 chars (INV:3795). */
export function invoicePrefixFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const p = (env.TRANCHE_INVOICE_PREFIX || INVOICE_PREFIX).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{0,11}$/.test(p)) throw new Error(`TRANCHE_INVOICE_PREFIX must be 1-12 of A-Z, 0-9, '-' (got ${JSON.stringify(p)})`);
  return p;
}
