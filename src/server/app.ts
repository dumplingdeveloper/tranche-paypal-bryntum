import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DEMO_TODAY } from '../domain/mockData.ts';
import type { ShiftPreview } from '../domain/types.ts';
import { MockInvoicingClient } from '../paypal/mockInvoicing.ts';
import { InvoicingError, type InvoicingClient } from '../paypal/invoicing.ts';
import { PaymentWatcher, type PaymentEvent } from '../paypal/watcher.ts';
import type { AgentRunner, AgentTurn } from '../agent/runner.ts';
import type { ToolHost } from '../agent/tools.ts';
import { AuditLog } from './audit.ts';
import { Board, scheduleToObject } from './board.ts';
import { BrokerError, ConfirmationBroker } from './broker.ts';
import { serveStatic } from './static.ts';

export type TrancheOptions = {
  today?: string;
  agent: (host: ToolHost) => AgentRunner;
  auditFile?: string;
  pollMs?: number;
  autoWatch?: boolean;
  /** Defaults to the deterministic mock. `TRANCHE_PAYPAL=sandbox` passes a SandboxInvoicingClient. */
  invoicing?: InvoicingClient;
  /** Real calendar date (tests inject one); sandbox demo controls never send a date later than this. */
  realToday?: () => string;
};

type EngineDates = Record<string, { start: string; end: string }>;
type Message = { id: string; role: 'owner' | 'agent' | 'event'; text: string; turn_id?: string; mode?: string; live?: boolean; at: string; tool_calls?: AgentTurn['tool_calls'] };

class HttpError extends Error { status: number; code: string; constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; } }

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const ct = String(req.headers['content-type'] || '');
  // JSON-only POSTs: a cross-site form cannot send this without a CORS preflight, which we never answer.
  if (!ct.startsWith('application/json')) throw new HttpError(415, 'JSON_REQUIRED', 'Content-Type must be application/json');
  let size = 0; const chunks: Buffer[] = [];
  for await (const c of req) { size += (c as Buffer).length; if (size > 64_000) throw new HttpError(413, 'TOO_LARGE', 'Body too large'); chunks.push(c as Buffer); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'BAD_JSON', 'Invalid JSON'); }
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

export async function createTranche(opts: TrancheOptions) {
  const today = opts.today || DEMO_TODAY;
  const audit = new AuditLog(opts.auditFile);
  const invoicing: InvoicingClient = opts.invoicing || new MockInvoicingClient({ today: () => today });
  const board = new Board(today);
  const broker = new ConfirmationBroker(audit);
  const clients = new Set<ServerResponse>();
  const transcript: Message[] = [];
  const turns: AgentTurn[] = [];
  let msgSeq = 0; let turnSeq = 0;
  let agentBusy = false;
  let queue: Promise<unknown> = Promise.resolve();
  let lastPreview: ShiftPreview | null = null;

  const broadcast = (type: string, data: unknown) => {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(frame);
  };
  let stateTimer: ReturnType<typeof setTimeout> | undefined;
  const stateChanged = () => {
    if (stateTimer) return;
    stateTimer = setTimeout(() => { stateTimer = undefined; broadcast('state', snapshot()); }, 15);
  };
  const addMessage = (m: Omit<Message, 'id' | 'at'>) => {
    const msg: Message = { id: `m${++msgSeq}`, at: new Date().toISOString(), ...m };
    transcript.push(msg);
    broadcast('message', msg);
    return msg;
  };

  const host: ToolHost = {
    board, broker, audit,
    reminders: (id) => invoicing.remindersOn(id),
    previewShown: (p) => { lastPreview = p; broadcast('preview', p); stateChanged(); },
    applySchedule: (p, confirmationId) => {
      const change = board.apply(p, confirmationId);
      const expected = scheduleToObject(board.schedule());
      audit.append('owner', 'schedule.applied', { confirmation_id: confirmationId, preview_id: p.preview_id, invoice_number: p.invoice.invoice_number, plan_date_from: change.from, plan_date_to: change.to, moved: p.moved.length });
      lastPreview = null;
      broadcast('schedule.applied', { confirmation_id: confirmationId, preview_id: p.preview_id, invoice_number: p.invoice.invoice_number, plan_date: p.assumed_payment_date, expected });
      stateChanged();
      return change;
    },
    sendReminder: async (invoiceId, notification) => {
      await invoicing.remindInvoice(invoiceId, notification);
      const inv = await invoicing.getInvoice(invoiceId);
      const entry = audit.append('paypal', 'paypal.invoice.remind', { invoice_id: invoiceId, invoice_number: inv.detail.invoice_number, mode: invoicing.mode, endpoint: 'POST /v2/invoicing/invoices/{invoice_id}/remind', notification, reminders_today: invoicing.remindersOn(invoiceId) });
      stateChanged();
      return { sent: true, mode: invoicing.mode, audit_seq: entry.seq };
    },
  };

  broker.onChange((c) => {
    // Ghost bars follow the server's latest preview; drop them once its card is resolved.
    if (c.kind === 'apply_schedule' && c.status !== 'pending' && lastPreview?.preview_id === c.preview_id) lastPreview = null;
    stateChanged();
  });
  const agent = opts.agent(host);
  audit.append('system', 'agent.mode', { ...agent.info });

  function askAgent(prompt: string, trigger: AgentTurn['trigger']) {
    const turnId = `t${++turnSeq}`;
    if (trigger === 'owner') addMessage({ role: 'owner', text: prompt, turn_id: turnId });
    const run = queue.then(async () => {
      agentBusy = true; stateChanged();
      broadcast('agent', { type: 'status', status: 'thinking', turn_id: turnId });
      let turn: AgentTurn;
      try {
        turn = await agent.ask(prompt, { turnId, trigger, onEvent: (e) => broadcast('agent', { ...e, turn_id: turnId }) });
      } catch (err) {
        turn = { turn_id: turnId, mode: agent.info.mode, live: agent.info.live, trigger, prompt, text: `Agent error: ${(err as Error).message}`, tool_calls: [], duration_ms: 0, ok: false, error: (err as Error).message };
      }
      turns.push(turn);
      audit.append('agent', 'agent.turn', { turn_id: turnId, mode: turn.mode, live: turn.live, model: turn.model, trigger, ok: turn.ok, tool_calls: turn.tool_calls.map((c) => c.tool), model_requests: turn.model_requests, duration_ms: turn.duration_ms, error: turn.error });
      addMessage({ role: 'agent', text: turn.text, turn_id: turnId, mode: turn.mode, live: turn.live, tool_calls: turn.tool_calls });
      agentBusy = false;
      broadcast('agent', { type: 'status', status: 'idle', turn_id: turnId });
      stateChanged();
      return turn;
    });
    queue = run.catch(() => {});
    return { turnId, done: run };
  }

  const AUTO_EVENTS = new Set(['INVOICING.INVOICE.PAID', 'INVOICING.INVOICE.REFUNDED', 'INVOICING.INVOICE.CANCELLED']);
  const watcher = new PaymentWatcher(invoicing, {
    today: () => today,
    onEvents: (events: PaymentEvent[], invoices) => {
      board.setInvoices(invoices);
      if (events.some((e) => !e.initial)) broker.sweepStale(`PayPal: ${events.filter((e) => !e.initial).map((e) => `${e.invoice_number} ${e.event_type}`).join(', ')}`);
      for (const e of events) {
        audit.append(e.source === 'tranche-clock' ? 'system' : 'paypal', 'paypal.event', { ...e });
        addMessage({ role: 'event', text: `${e.event_type} · ${e.summary}` });
      }
      if (events.length) broadcast('paypal.events', events);
      stateChanged();
      if (opts.autoWatch) {
        for (const e of events.filter((x) => !x.initial && AUTO_EVENTS.has(x.event_type))) {
          askAgent(`PayPal event ${e.event_type} (${e.source}): ${e.summary} Review the board and, if the plan should change, preview it and ask me to approve.`, 'paypal-event');
        }
      }
    },
  });
  await watcher.poll();
  if (opts.pollMs) watcher.start(opts.pollMs);

  function snapshot() {
    return {
      ...board.snapshot(host.reminders),
      modes: { paypal: invoicing.mode, paypal_endpoint: invoicing.baseUrl ?? null, agent: agent.info },
      confirmations: broker.list(),
      audit: audit.entries,
      events: watcher.history,
      transcript,
      agent_busy: agentBusy,
      last_preview: lastPreview,
      mock_calls: invoicing.calls,
      paypal_calls: invoicing.calls,
    };
  }

  function engineCheck(engine: EngineDates) {
    const expected = scheduleToObject(board.schedule());
    const mismatches: string[] = [];
    for (const [id, want] of Object.entries(expected)) {
      const got = engine[id];
      if (!got || got.start !== want.start || got.end !== want.end) mismatches.push(`${id}: engine ${got?.start}..${got?.end} vs scheduler ${want.start}..${want.end}`);
    }
    return { checked: Object.keys(expected).length, matched: Object.keys(expected).length - mismatches.length, mismatches };
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const path = url.pathname;
    try {
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}`) throw new HttpError(403, 'BAD_ORIGIN', 'Cross-origin request refused');
      }
      if (req.method === 'GET' && path === '/api/state') return send(res, 200, snapshot());
      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }
      if (req.method === 'POST' && path === '/api/agent/ask') {
        const body = await readJson(req);
        const prompt = String(body.prompt || '').trim().slice(0, 2000);
        if (!prompt) throw new HttpError(400, 'EMPTY_PROMPT', 'prompt is required');
        const { turnId } = askAgent(prompt, 'owner');
        return send(res, 202, { turn_id: turnId });
      }
      const m = /^\/api\/confirmations\/(cf_\d+)\/(approve|reject)$/.exec(path);
      if (req.method === 'POST' && m) {
        const body = await readJson(req);
        const c = m[2] === 'approve' ? await broker.approve(m[1], String(body.payload_hash || '')) : broker.reject(m[1], String(body.reason || 'rejected by owner'));
        if (m[2] === 'approve') broker.sweepStale(`${c.id} applied`);
        stateChanged();
        return send(res, 200, c);
      }
      if (req.method === 'POST' && path === '/api/schedule/undo') {
        const body = await readJson(req);
        let change;
        try { change = board.undo(String(body.confirmation_id || '')); } catch (err) { throw new HttpError(409, 'CANNOT_UNDO', (err as Error).message); }
        audit.append('owner', 'schedule.undone', { confirmation_id: change.confirmation_id, preview_id: change.preview_id, invoice_number: change.invoice_number, plan_date_restored: change.from, via: 'bryntum-stm' });
        const expected = scheduleToObject(board.schedule());
        broadcast('schedule.undone', { confirmation_id: change.confirmation_id, invoice_number: change.invoice_number, plan_date: change.from, expected });
        broker.sweepStale(`${change.confirmation_id} undone`);
        stateChanged();
        return send(res, 200, { undone: change, expected });
      }
      if (req.method === 'POST' && path === '/api/schedule/engine-report') {
        const body = await readJson(req);
        const check = engineCheck((body.engine || {}) as EngineDates);
        const reason = String(body.reason || 'report');
        audit.append('browser', check.mismatches.length ? 'engine.mismatch' : 'engine.verified', { reason, confirmation_id: body.confirmation_id, ...check, stm: body.stm });
        stateChanged();
        return send(res, 200, check);
      }
      if (req.method === 'POST' && path === '/api/paypal/poll') {
        const events = await watcher.poll();
        return send(res, 200, { events });
      }
      if (req.method === 'POST' && path === '/api/mock/simulate') {
        const body = await readJson(req);
        const num = String(body.invoice_number || '');
        const action = String(body.action || '');
        const inv = board.invoice(num);
        if (!inv) throw new HttpError(404, 'INVOICE_NOT_FOUND', `No invoice ${num}`);
        let result: unknown;
        const sandbox = invoicing.mode === 'sandbox';
        // The real sandbox may refuse a payment/refund date in the future, so the demo clock is clamped to the real date there.
        const realToday = opts.realToday ? opts.realToday() : new Date().toISOString().slice(0, 10);
        const actionDate = sandbox && realToday < today ? realToday : today;
        if (action === 'payer_pays') {
          // A real PayPal payment needs a sandbox buyer in a browser; only the mock can simulate it.
          if (!(invoicing instanceof MockInvoicingClient)) throw new HttpError(409, 'NEEDS_BROWSER_PAYER', 'In SANDBOX mode a PayPal payment comes from a sandbox buyer paying the invoice link in a browser. Use "Record bank transfer" to record a payment via the API instead.');
          result = await invoicing.simulatePayerPayment(inv.id, today);
        } else if (action === 'record_external_payment') result = await invoicing.recordPayment(inv.id, { payment_date: actionDate, method: 'BANK_TRANSFER', note: `Recorded in Tranche demo (${invoicing.mode})` });
        else if (action === 'refund') result = await invoicing.recordRefund(inv.id, { refund_date: actionDate, method: 'BANK_TRANSFER' });
        else if (action === 'cancel') result = await invoicing.cancelInvoice(inv.id, { send_to_recipient: false });
        else throw new HttpError(400, 'BAD_ACTION', 'action must be payer_pays | record_external_payment | refund | cancel');
        audit.append('demo-control', sandbox ? 'sandbox.demo_control' : 'mock.simulate', { action, invoice_number: num, result, note: sandbox ? 'PayPal SANDBOX API call made from a demo control' : 'MOCK PayPal: demo control, not a real PayPal call' });
        const events = await watcher.poll();
        return send(res, 200, { result: result ?? null, events });
      }
      if (req.method === 'GET') return serveStatic(path, res, req);
      throw new HttpError(404, 'NOT_FOUND', 'not found');
    } catch (err) {
      if (err instanceof HttpError || err instanceof BrokerError) return send(res, err.status, { error: { code: err.code, message: err.message } });
      if (err instanceof InvoicingError) return send(res, err.status >= 400 ? err.status : 502, { error: { code: err.issue, message: err.message } });
      return send(res, 500, { error: { code: 'INTERNAL', message: (err as Error).message } });
    }
  }

  const server = createServer((req, res) => { handle(req, res).catch(() => { if (!res.headersSent) send(res, 500, { error: { code: 'INTERNAL' } }); }); });

  return {
    server, board, broker, audit, invoicing, watcher, agent, transcript, turns, snapshot, askAgent,
    listen(port: number, hostName = '127.0.0.1') {
      return new Promise<number>((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(port, hostName, () => { const a = server.address(); resolveListen(typeof a === 'object' && a ? a.port : port); });
      });
    },
    async close() {
      watcher.stop();
      for (const c of clients) c.end();
      clients.clear();
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections();
      await closed;
      await agent.stop();
    },
  };
}

export type TrancheApp = Awaited<ReturnType<typeof createTranche>>;
