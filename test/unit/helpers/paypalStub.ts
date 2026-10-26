// A local stand-in for the PayPal sandbox REST Invoicing v2 API, shaped from invoicing_v2.json (INV:line) so the
// SandboxInvoicingClient can be tested without credentials or network. It is NOT PayPal: behaviour the spec leaves
// open (e.g. past due dates) is a test knob, and the stub's own error issues start with STUB_.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type StubRequest = { method: string; path: string; query: URLSearchParams; headers: IncomingMessage['headers']; body: string; json?: any };
type Fault = { method?: string; path: RegExp; status: number; headers?: Record<string, string>; body?: unknown; times: number; network?: boolean };

export type StubOptions = {
  clientId: string; clientSecret: string;
  token?: string; expiresIn?: number;
  /** Behaviour the spec does not define: reject a due_date before the stub's "today". */
  rejectPastDueDate?: boolean;
  today?: string;
  /** Ignore `Prefer: return=representation` and return a link_description like INV:104 describes. */
  linkOnly?: boolean;
};

const money = (currency_code: string, value: number) => ({ currency_code, value: value.toFixed(2) });

export async function startPayPalStub(o: StubOptions) {
  const requests: StubRequest[] = [];
  const invoices = new Map<string, any>();
  const faults: Fault[] = [];
  let seq = 0; let tokenSeq = 0;
  const issued = new Set<string>();
  const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'paypal-debug-id': `stubdebug${requests.length}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  // error_default (INV:3506): name, message, debug_id, details[].issue/description.
  const err = (res: ServerResponse, status: number, issue: string, description: string) =>
    send(res, status, { name: status === 404 ? 'RESOURCE_NOT_FOUND' : 'UNPROCESSABLE_ENTITY', message: description, debug_id: `stubdebug${requests.length}`, details: [{ issue, description }] });

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url || '/', 'http://stub');
    const body = Buffer.concat(chunks).toString('utf8');
    let json: any; try { json = body ? JSON.parse(body) : undefined; } catch { /* form body */ }
    const r: StubRequest = { method: req.method || 'GET', path: url.pathname, query: url.searchParams, headers: req.headers, body, json };
    requests.push(r);

    const fault = faults.find((f) => f.times > 0 && f.path.test(r.path) && (!f.method || f.method === r.method));
    if (fault) {
      fault.times--;
      if (fault.network) { req.socket.destroy(); return; }
      return send(res, fault.status, fault.body, fault.headers);
    }

    if (r.method === 'POST' && r.path === '/v1/oauth2/token') {
      const expected = `Basic ${Buffer.from(`${o.clientId}:${o.clientSecret}`).toString('base64')}`;
      if (req.headers.authorization !== expected || body !== 'grant_type=client_credentials') return send(res, 401, { error: 'invalid_client', error_description: 'Client Authentication failed' });
      const token = `${o.token || 'stub-access-token'}-${++tokenSeq}`;
      issued.add(token);
      return send(res, 200, { scope: 'https://uri.paypal.com/services/invoicing', access_token: token, token_type: 'Bearer', app_id: 'APP-STUB', expires_in: o.expiresIn ?? 32400 });
    }
    const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (!issued.has(bearer)) return send(res, 401, { error: 'invalid_token', error_description: 'Token signature verification failed' });

    const m = /^\/v2\/invoicing\/invoices\/([^/]+)(?:\/(send|remind|cancel|payments|refunds))?$/.exec(r.path);
    const inv = m ? invoices.get(decodeURIComponent(m[1])) : undefined;
    const page = Number(r.query.get('page') || 1); const size = Number(r.query.get('page_size') || 20);
    const paged = (all: any[]) => ({ items: all.slice((page - 1) * size, page * size), total_items: all.length, total_pages: Math.max(1, Math.ceil(all.length / size)), links: [] });

    if (r.method === 'POST' && r.path === '/v2/invoicing/invoices') {
      const d = json?.detail || {};
      if (!d.currency_code) return err(res, 400, 'MISSING_REQUIRED_PARAMETER', 'detail.currency_code is required');
      // Real sandbox 2026-10-26 (artifacts/sandbox/probe-2026-10-26-9112L.json): 422 DUPLICATE_INVOICE_NUMBER, field /detail/invoice_number.
      if ([...invoices.values()].some((x) => x.detail.invoice_number === d.invoice_number)) return send(res, 422, { name: 'UNPROCESSABLE_ENTITY', message: 'The requested action could not be performed, semantically incorrect, or failed business validation.', debug_id: 'stubdebugdup', details: [{ field: '/detail/invoice_number', location: 'body', issue: 'DUPLICATE_INVOICE_NUMBER', description: 'Invoice number is duplicate.' }] });
      if (o.rejectPastDueDate && d.payment_term?.due_date && d.payment_term.due_date < (o.today || '0000')) {
        // Shape of a validation error per https://developer.paypal.com/api/rest/responses/ (details[].field/value/location/issue).
        return send(res, 422, { name: 'UNPROCESSABLE_ENTITY', message: 'The requested action could not be performed.', debug_id: 'stubdebugdue', details: [{ field: '/detail/payment_term/due_date', value: d.payment_term.due_date, location: 'body', issue: 'STUB_INVALID_VALUE', description: 'Value is invalid (stub knob).' }] });
      }
      const id = `INV2-STUB-0000-0000-${String(++seq).padStart(4, '0')}`;
      const total = (json.items || []).reduce((s: number, it: any) => s + Number(it.quantity || 1) * Number(it.unit_amount?.value || 0), 0);
      const created = { id, status: 'DRAFT', detail: { ...d, metadata: { create_time: `${d.invoice_date}T09:00:00Z` } }, primary_recipients: json.primary_recipients, items: json.items, amount: money(d.currency_code, total), links: [{ href: `http://stub/v2/invoicing/invoices/${id}`, rel: 'self', method: 'GET' }] };
      invoices.set(id, created);
      // INV:104: the full invoice only with Prefer: return=representation; otherwise a link_description.
      if (!o.linkOnly && /return=representation/.test(String(req.headers.prefer || ''))) return send(res, 201, created);
      return send(res, 201, { rel: 'self', href: `http://stub/v2/invoicing/invoices/${id}`, method: 'GET' });
    }
    if (r.method === 'GET' && r.path === '/v2/invoicing/invoices') return send(res, 200, paged([...invoices.values()]));
    if (r.method === 'POST' && r.path === '/v2/invoicing/search-invoices') {
      let all = [...invoices.values()];
      // Real sandbox: invoice_number matches as a prefix (full number → 1, prefix → 1, middle substring → 0; probe-2026-10-26-9112L.json).
      if (json?.invoice_number) all = all.filter((x) => String(x.detail.invoice_number).startsWith(json.invoice_number));
      if (json?.status?.length) all = all.filter((x) => json.status.includes(x.status));
      // Real sandbox: search items carry payments.paid_amount / refunds.refund_amount but NO transactions (dates); only
      // GET /invoices/{id} has them (artifacts/sandbox/search-shape-2026-10-26.json).
      const summary = (x: any) => ({ ...x, ...(x.payments ? { payments: { paid_amount: x.payments.paid_amount } } : {}), ...(x.refunds ? { refunds: { refund_amount: x.refunds.refund_amount } } : {}) });
      return send(res, 200, paged(all.map(summary)));
    }
    if (!m) return err(res, 404, 'STUB_NO_ROUTE', `No route ${r.method} ${r.path}`);
    if (!inv) return err(res, 404, 'INVALID_RESOURCE_ID', 'Requested resource ID was not found.');
    const action = m[2];
    if (!action && r.method === 'GET') return send(res, 200, inv);
    if (!action && r.method === 'DELETE') {
      // INV:1695: "Deletes invoices in the draft or scheduled state only."
      if (!['DRAFT', 'SCHEDULED'].includes(inv.status)) return err(res, 422, 'STUB_CANNOT_DELETE', 'Only draft or scheduled invoices can be deleted');
      invoices.delete(inv.id); return send(res, 204);
    }
    if (action === 'send') {
      // INV:340: issue date in the future → SCHEDULED, otherwise sent now.
      // Real sandbox: a share-link send (send_to_recipient=false) leaves the invoice UNPAID (probe). SENT for an e-mailed send is not verified.
      inv.status = inv.detail.invoice_date > (o.today || '9999') ? 'SCHEDULED' : json?.send_to_recipient === false ? 'UNPAID' : 'SENT';
      return send(res, 200, { rel: 'self', href: `http://stub/v2/invoicing/invoices/${inv.id}`, method: 'GET' });
    }
    if (action === 'remind') return send(res, 204);
    if (action === 'cancel') {
      // Real sandbox: 422 CANNOT_CANCEL_PAID_INVOICE "Cannot cancel a paid or partially paid invoice." (probe).
      if (/PAID/.test(inv.status) && inv.status !== 'UNPAID') return send(res, 422, { name: 'UNPROCESSABLE_ENTITY', message: 'The requested action could not be performed.', debug_id: 'stubdebugcancel', details: [{ field: 'invoiceId', location: 'path', issue: 'CANNOT_CANCEL_PAID_INVOICE', description: 'Cannot cancel a paid or partially paid invoice.' }] });
      inv.status = 'CANCELLED'; return send(res, 204);
    }
    if (action === 'payments') {
      if (!json?.method) return err(res, 400, 'MISSING_REQUIRED_PARAMETER', 'method is required');
      const paidBefore = Number(inv.payments?.paid_amount?.value || 0);
      const amt = Number(json.amount?.value ?? Number(inv.amount.value) - paidBefore);
      const payment_id = `EXTR-STUB-${++seq}`;
      const transactions = [...(inv.payments?.transactions || []), { payment_id, type: 'EXTERNAL', method: json.method, payment_date: json.payment_date, amount: money(inv.amount.currency_code, amt), ...(json.note ? { note: json.note } : {}) }];
      const paid = paidBefore + amt;
      inv.payments = { paid_amount: money(inv.amount.currency_code, paid), transactions };
      // INV:745: "If no payment is due, the invoice is marked as PAID. Otherwise ... PARTIALLY PAID."
      // Real sandbox: a fully recorded external payment gives MARKED_AS_PAID (probe). PARTIALLY_PAID is from INV:745, not verified.
      inv.status = paid + 1e-9 >= Number(inv.amount.value) ? 'MARKED_AS_PAID' : 'PARTIALLY_PAID';
      return send(res, 200, { payment_id });
    }
    if (action === 'refunds') {
      const refund_id = `EXTR-REF-STUB-${++seq}`;
      inv.refunds = { refund_amount: money(inv.amount.currency_code, Number(json?.amount?.value ?? inv.amount.value)), transactions: [{ refund_id, type: 'EXTERNAL', method: json?.method, refund_date: json?.refund_date }] };
      inv.status = 'REFUNDED';
      return send(res, 200, { refund_id });
    }
    return err(res, 404, 'STUB_NO_ROUTE', `No route ${r.method} ${r.path}`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests, invoices,
    fail(f: Omit<Fault, 'times'> & { times?: number }) { faults.push({ times: 1, ...f }); },
    put(raw: any) { invoices.set(raw.id, raw); },
    calls(method: string, path: RegExp | string) { return requests.filter((r) => r.method === method && (typeof path === 'string' ? r.path === path : path.test(r.path))); },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
