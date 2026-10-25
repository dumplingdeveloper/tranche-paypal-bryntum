import { createHash } from 'node:crypto';
import type { AuditLog } from './audit.ts';

export type ConfirmationKind = 'apply_schedule' | 'send_reminder';
export type ConfirmationStatus = 'pending' | 'approved' | 'rejected' | 'stale' | 'superseded' | 'failed';

export type Confirmation = {
  id: string;
  kind: ConfirmationKind;
  status: ConfirmationStatus;
  invoice_number: string;
  preview_id?: string;
  payload: unknown;
  payload_hash: string;
  summary: string;
  requested_by: string;
  created_at: string;
  resolved_at?: string;
  resolution?: string;
  result?: unknown;
};

type Hooks = {
  // Recomputes the payload from the *current* board; a different hash means the card is stale.
  recheck: () => unknown;
  execute: (payload: unknown, confirmation: Confirmation) => Promise<unknown> | unknown;
};

export class BrokerError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

const canonical = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
};
export const hashPayload = (payload: unknown) => createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');

// Human gate: agent tools can only *create* pending confirmations; only the owner's approve() executes them, and
// only if the payload hash the owner saw still equals a fresh recomputation from the current board.
export class ConfirmationBroker {
  private items: Confirmation[] = [];
  private hooks = new Map<string, Hooks>();
  private seq = 0;
  private listeners: Array<(c: Confirmation) => void> = [];

  private audit: AuditLog;
  constructor(audit: AuditLog) { this.audit = audit; }

  onChange(fn: (c: Confirmation) => void) { this.listeners.push(fn); }
  private changed(c: Confirmation) { for (const l of this.listeners) l(c); }

  list() { return this.items.map((c) => structuredClone(c)); }
  get(id: string) { return this.items.find((c) => c.id === id); }

  create(input: { kind: ConfirmationKind; invoice_number: string; preview_id?: string; payload: unknown; summary: string; requested_by: string } & Hooks): Confirmation {
    const { recheck, execute, ...rest } = input;
    for (const old of this.items) {
      if (old.status === 'pending' && old.kind === rest.kind && old.invoice_number === rest.invoice_number) {
        this.resolve(old, 'superseded', `superseded by a newer ${rest.kind} request`);
        this.audit.append('system', 'confirmation.superseded', { id: old.id, kind: old.kind, invoice_number: old.invoice_number });
      }
    }
    const c: Confirmation = { id: `cf_${String(++this.seq).padStart(4, '0')}`, status: 'pending', ...rest, payload: structuredClone(rest.payload), payload_hash: hashPayload(rest.payload), created_at: new Date().toISOString() };
    this.items.push(c);
    this.hooks.set(c.id, { recheck, execute });
    this.audit.append('agent', 'confirmation.requested', { id: c.id, kind: c.kind, invoice_number: c.invoice_number, preview_id: c.preview_id, payload_hash: c.payload_hash, requested_by: c.requested_by });
    this.changed(c);
    return structuredClone(c);
  }

  private resolve(c: Confirmation, status: ConfirmationStatus, resolution: string, result?: unknown) {
    c.status = status;
    c.resolution = resolution;
    c.resolved_at = new Date().toISOString();
    if (result !== undefined) c.result = result;
    this.hooks.delete(c.id);
    this.changed(c);
  }

  async approve(id: string, payloadHash: string, actor: 'owner' = 'owner'): Promise<Confirmation> {
    const c = this.get(id);
    if (!c) throw new BrokerError(404, 'NOT_FOUND', `No confirmation ${id}`);
    if (c.status !== 'pending') throw new BrokerError(409, 'ALREADY_RESOLVED', `Confirmation ${id} is ${c.status}`);
    if (payloadHash !== c.payload_hash) {
      this.audit.append(actor, 'confirmation.hash_mismatch', { id, expected: c.payload_hash, got: payloadHash });
      throw new BrokerError(409, 'HASH_MISMATCH', 'The approved payload is not the one on record.');
    }
    const hooks = this.hooks.get(id)!;
    let fresh: string;
    try { fresh = hashPayload(hooks.recheck()); } catch (err) { fresh = `error:${(err as Error).message}`; }
    if (fresh !== c.payload_hash) {
      this.resolve(c, 'stale', `board changed since the preview (${fresh.startsWith('error:') ? fresh.slice(6) : 'different result now'})`);
      this.audit.append(actor, 'confirmation.rejected_stale', { id, kind: c.kind, invoice_number: c.invoice_number, preview_id: c.preview_id, reason: c.resolution });
      throw new BrokerError(409, 'STALE', `Confirmation ${id} is stale: ${c.resolution}. Ask the agent for a fresh preview.`);
    }
    try {
      const result = await hooks.execute(structuredClone(c.payload), structuredClone(c));
      this.resolve(c, 'approved', `approved by ${actor}`, result);
      this.audit.append(actor, 'confirmation.approved', { id, kind: c.kind, invoice_number: c.invoice_number, preview_id: c.preview_id, payload_hash: c.payload_hash });
      return structuredClone(c);
    } catch (err) {
      const e = err as Error & { issue?: string };
      this.resolve(c, 'failed', e.message, { error: e.message, issue: e.issue });
      this.audit.append(actor, 'confirmation.failed', { id, kind: c.kind, invoice_number: c.invoice_number, error: e.message, issue: e.issue });
      throw new BrokerError(422, e.issue || 'EXECUTE_FAILED', e.message);
    }
  }

  // Proactive sweep after the board changes (PayPal event, apply, undo): pending cards whose fresh payload no longer
  // matches are marked stale at once, so the owner never sees an Apply button for an outdated preview.
  // approve() still re-checks, so a change racing the click is also caught.
  sweepStale(cause: string): Confirmation[] {
    const marked: Confirmation[] = [];
    for (const c of this.items.filter((x) => x.status === 'pending')) {
      const hooks = this.hooks.get(c.id);
      if (!hooks) continue;
      let fresh: string;
      try { fresh = hashPayload(hooks.recheck()); } catch (err) { fresh = `error:${(err as Error).message}`; }
      if (fresh === c.payload_hash) continue;
      this.resolve(c, 'stale', `board changed since the preview (${cause}; ${fresh.startsWith('error:') ? fresh.slice(6) : 'different result now'})`);
      this.audit.append('system', 'confirmation.marked_stale', { id: c.id, kind: c.kind, invoice_number: c.invoice_number, preview_id: c.preview_id, cause, reason: c.resolution });
      marked.push(structuredClone(c));
    }
    return marked;
  }

  reject(id: string, reason = 'rejected by owner', actor: 'owner' = 'owner') {
    const c = this.get(id);
    if (!c) throw new BrokerError(404, 'NOT_FOUND', `No confirmation ${id}`);
    if (c.status !== 'pending') throw new BrokerError(409, 'ALREADY_RESOLVED', `Confirmation ${id} is ${c.status}`);
    this.resolve(c, 'rejected', reason);
    this.audit.append(actor, 'confirmation.rejected', { id, kind: c.kind, invoice_number: c.invoice_number, reason });
    return structuredClone(c);
  }
}
