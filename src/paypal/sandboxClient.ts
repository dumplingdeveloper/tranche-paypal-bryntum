// Live PayPal Invoicing v2 client for the SANDBOX only (TRANCHE_PAYPAL=sandbox). Written fresh for Tranche.
// Endpoint and field names come from PayPal's OpenAPI spec invoicing_v2.json ("INV:<line>") and the OAuth docs;
// see docs/FACTS_PAYPAL_INVOICING.md §"Sandbox client". Status: unit-tested against a local stub server only; it has
// NOT been run against the real sandbox yet (no credentials).
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InvoiceStatus, Money, PayPalInvoice } from '../domain/types.ts';
import { InvoicingError, type InvoicingCall, type InvoiceNotification, type InvoiceSearch, type InvoicingClient, type PaymentDetail, type RefundDetail } from './invoicing.ts';

export const SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com'; // INV:11 (servers[0])
export const CREDENTIALS_FILE = join(homedir(), '.config', 'tillwise', 'paypal-sandbox.env');
/** Prefix on PayPal invoice numbers so Tranche never touches other invoices in a shared sandbox account. */
export const INVOICE_PREFIX = 'TRANCHE-';
/** `detail.reference` tag (INV:3116, max 120 chars) written by `npm run sandbox:seed`. */
export const SEED_REFERENCE = 'tranche-demo/v1';
/**
 * app_id of PayPal's default PUBLIC sandbox credential set (collection variables client_id / client_secret in
 * https://github.com/paypal/postman-collections Collections/PayPal_Public_APIs.json). The token response carries
 * app_id, so Tranche can say on screen that this shared app is in use without ever storing the credentials.
 */
export const PUBLIC_DEFAULT_APP_ID = 'APP-80W284485P519543T';
/** Where `npm run sandbox:seed` remembers the invoice-number prefix of this checkout's demo set (gitignored). */
export const SANDBOX_STATE_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../.tranche/sandbox-state.json');
export type SandboxState = { prefix: string; created_at: string; base_url: string; app_id?: string };

export function readSandboxState(file = SANDBOX_STATE_FILE): SandboxState | undefined {
  try { const st = JSON.parse(readFileSync(file, 'utf8')); return typeof st?.prefix === 'string' ? st : undefined; } catch { return undefined; }
}
export function writeSandboxState(state: SandboxState, file = SANDBOX_STATE_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}
/** A fresh, unique prefix such as `TR-K3F9Q-`, so sets seeded in a shared sandbox app never collide. */
export function newDemoPrefix(rand: () => number = Math.random) {
  const abc = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let tag = '';
  for (let i = 0; i < 5; i++) tag += abc[Math.floor(rand() * abc.length)];
  return `TR-${tag}-`;
}

export type SandboxCredentials = { clientId: string; clientSecret: string };
export type CredentialLookup = { creds?: SandboxCredentials; source: 'env' | 'file' | 'env+file' | 'none'; file: string; warnings: string[] };

export function parseEnvFile(text: string) {
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
  /** Append one JSON line per HTTP request (method, path, status, PayPal-Debug-Id; never headers or bodies). */
  callLog?: string;
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
  // Every token this client has held, so an old token is still masked after a refresh.
  private seenTokens = new Set<string>();
  /** HTTP requests this client sent to PayPal (token, reads, writes, retries), for the shared-app call budget. */
  requestCount = 0;
  /** `app_id` from the OAuth token response (not a secret); PUBLIC_DEFAULT_APP_ID means PayPal's shared public app. */
  appId?: string;
  private callLog?: string;

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
    this.callLog = o.callLog;
  }

  /** Replace any credential or token value in a string before it is logged or thrown. */
  mask(text: string) {
    let out = String(text);
    const basic = Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString('base64');
    for (const s of [basic, this.creds.clientSecret, this.creds.clientId, ...this.seenTokens]) if (s && s.length >= 4) out = out.split(s).join('***');
    return out;
  }

  private log(line: string) { this.logLine(this.mask(line)); }

  private logCall(method: string, path: string, res: Response | undefined, netErr: Error | undefined, startedAt = Date.now()) {
    if (!this.callLog) return;
    const line = { at: new Date().toISOString(), host: new URL(this.baseUrl).host, method, path: path.split('?')[0], status: res?.status ?? 0, ms: Date.now() - startedAt, debug_id: res?.headers.get('paypal-debug-id') || undefined, ...(netErr ? { error: this.mask(netErr.message) } : {}), n: this.requestCount };
    try { appendFileSync(this.callLog, `${JSON.stringify(line)}\n`); } catch { /* the ledger is best effort */ }
  }

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
        if (body.app_id) this.appId = String(body.app_id);
        this.seenTokens.add(this.token.value);
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
      const started = Date.now();
      try {
        this.requestCount++;
        res = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers: init.headers, body: init.body });
      } catch (err) { netErr = err as Error; }
      this.logCall(method, path, res, netErr, started);
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

  // PayPal error body (INV:3506 error_default → name, message, debug_id INV:3206, details[].field/issue/description).
  private async toError(method: string, path: string, res: Response) {
    const text = await res.text().catch(() => '');
    let body: any = {};
    try { body = JSON.parse(text); } catch { /* non-JSON */ }
    const debugId = res.headers.get('paypal-debug-id') || body.debug_id || 'n/a';
    const detail = body.details?.[0];
    const issue = String(detail?.issue || body.name || body.error || `HTTP_${res.status}`);
    const field = detail?.field ? ` [${detail.field}]` : '';
    const message = this.mask(`PayPal ${method} ${path} → ${res.status} ${issue}${field}: ${detail?.description || body.message || body.error_description || text.slice(0, 200)} (PayPal-Debug-Id ${debugId})`);
    this.log(message);
    const err = new InvoicingError(res.status, issue, message);
    err.debugId = debugId;
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

  /** POST /v2/invoicing/search-invoices (INV:1767, body search_data INV:6762), all pages; only invoices with our prefix. */
  async searchInvoices(query: InvoiceSearch & { invoice_number?: string } = {}): Promise<PayPalInvoice[]> {
    const body: Record<string, unknown> = {};
    if (query.status?.length) body.status = query.status;
    // search_data.invoice_number matches as a PREFIX in the real sandbox (probe 2026-10-26), so a bare search is scoped
    // to this client's prefix and never pages through other users' invoices in a shared sandbox app.
    body.invoice_number = `${this.prefix}${query.invoice_number || ''}`;
    const out: PayPalInvoice[] = [];
    for (let page = 1; page <= 20; page++) {
      const res = await this.api('POST', `/v2/invoicing/search-invoices?page=${page}&page_size=100&total_required=true`, body, { retryable: true });
      const data = await this.json(res) as { items?: unknown[]; total_pages?: number } | undefined;
      for (const raw of data?.items || []) {
        const n = String((raw as any)?.detail?.invoice_number || '');
        if (n.startsWith(this.prefix)) out.push(toDomainInvoice(await this.withTransactions(raw), this.prefix));
      }
      if (!data?.total_pages || page >= data.total_pages) break;
    }
    return out;
  }

  // The real search-invoices items carry payments.paid_amount / refunds.refund_amount but no transactions, so no payment
  // or refund DATE (artifacts/sandbox/search-shape-2026-10-26.json). The schedule needs that date, so such invoices are
  // read once with GET /invoices/{id} and cached until their status or amounts change (keeps 30 s polling to 1 call).
  private detailCache = new Map<string, { sig: string; raw: unknown }>();
  private async withTransactions(raw: any) {
    const missing = (raw?.payments && !Array.isArray(raw.payments.transactions)) || (raw?.refunds && !Array.isArray(raw.refunds.transactions));
    if (!missing || !raw?.id) return raw;
    const sig = JSON.stringify([raw.status, raw.payments?.paid_amount, raw.refunds?.refund_amount]);
    const hit = this.detailCache.get(raw.id);
    if (hit && hit.sig === sig) return hit.raw;
    const full = await this.json(await this.api('GET', `/v2/invoicing/invoices/${encodeURIComponent(raw.id)}`, undefined, { retryable: true }));
    this.detailCache.set(raw.id, { sig, raw: full });
    return full;
  }

  /** One page of POST /v2/invoicing/search-invoices with a caller-built `search_data` body (fact probe only). */
  async searchRaw(body: Record<string, unknown>, page = 1, pageSize = 20) {
    const res = await this.api('POST', `/v2/invoicing/search-invoices?page=${page}&page_size=${pageSize}&total_required=true`, body, { retryable: true });
    const data = await this.json(res) as { items?: any[]; total_items?: number; total_pages?: number } | undefined;
    const items = data?.items || [];
    return {
      total_items: data?.total_items, total_pages: data?.total_pages, numbers: items.map((i) => String(i?.detail?.invoice_number || '')),
      // Field NAMES only (no values): which parts of an invoice the search response carries.
      item_shapes: items.map((i) => ({ status: i?.status, keys: Object.keys(i || {}).sort(), detail_keys: Object.keys(i?.detail || {}).sort(), payments_keys: i?.payments ? Object.keys(i.payments).sort() : null })),
    };
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
    this.record('create_draft', inv.id, { invoice_number: input.invoice_number, representation: Boolean(data?.id) });
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
  return { client: new SandboxInvoicingClient({ ...opts, prefix: opts.prefix ?? invoicePrefixFromEnv(env), callLog: opts.callLog ?? (env.TRANCHE_PAYPAL_CALL_LOG || undefined), credentials: lookup.creds }), lookup };
}

/**
 * Invoice-number prefix: TRANCHE_INVOICE_PREFIX, else the prefix `npm run sandbox:seed` saved in the state file
 * (TRANCHE_SANDBOX_STATE overrides its path), else TRANCHE-. invoice_number is max 25 chars (INV:3795).
 */
export function invoicePrefixFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const saved = env.TRANCHE_INVOICE_PREFIX ? undefined : readSandboxState(env.TRANCHE_SANDBOX_STATE || SANDBOX_STATE_FILE)?.prefix;
  const p = (env.TRANCHE_INVOICE_PREFIX || saved || INVOICE_PREFIX).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{0,11}$/.test(p)) throw new Error(`TRANCHE_INVOICE_PREFIX must be 1-12 of A-Z, 0-9, '-' (got ${JSON.stringify(p)})`);
  return p;
}
