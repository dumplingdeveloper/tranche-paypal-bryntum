import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLog } from '../../src/server/audit.ts';
import { BrokerError, ConfirmationBroker, hashPayload } from '../../src/server/broker.ts';

const code = (c: string) => (e: unknown) => e instanceof BrokerError && e.code === c;

function setup() {
  const audit = new AuditLog();
  const broker = new ConfirmationBroker(audit);
  let world = { n: 1 };
  const executed: unknown[] = [];
  const make = (invoice = 'INV-2', kind: 'apply_schedule' | 'send_reminder' = 'apply_schedule', fail = false) => broker.create({
    kind, invoice_number: invoice, payload: { ...world }, summary: 's', requested_by: 'test',
    recheck: () => ({ ...world }),
    execute: (p) => { if (fail) throw Object.assign(new Error('boom'), { issue: 'CANNOT_REMIND_INVOICE' }); executed.push(p); return { ok: true }; },
  });
  return { audit, broker, executed, make, setWorld: (n: number) => { world = { n }; } };
}

test('hashPayload is canonical (key order independent)', () => {
  assert.equal(hashPayload({ a: 1, b: { c: 2, d: [1, 2] } }), hashPayload({ b: { d: [1, 2], c: 2 }, a: 1 }));
  assert.notEqual(hashPayload({ a: 1 }), hashPayload({ a: 2 }));
});

test('approve executes only with the matching hash, exactly once', async () => {
  const { broker, audit, executed, make } = setup();
  const c = make();
  await assert.rejects(broker.approve(c.id, 'deadbeef'), code('HASH_MISMATCH'));
  assert.equal(broker.get(c.id)!.status, 'pending');
  const done = await broker.approve(c.id, c.payload_hash);
  assert.equal(done.status, 'approved');
  assert.deepEqual(executed, [{ n: 1 }]);
  await assert.rejects(broker.approve(c.id, c.payload_hash), code('ALREADY_RESOLVED'));
  assert.deepEqual(audit.entries.map((e) => e.action), ['confirmation.requested', 'confirmation.hash_mismatch', 'confirmation.approved']);
});

test('stale previews are rejected and never executed', async () => {
  const { broker, audit, executed, make, setWorld } = setup();
  const c = make();
  setWorld(2);
  await assert.rejects(broker.approve(c.id, c.payload_hash), code('STALE'));
  assert.equal(broker.get(c.id)!.status, 'stale');
  assert.deepEqual(executed, []);
  assert.equal(audit.find('confirmation.rejected_stale').length, 1);
});

test('a newer request supersedes the pending one for the same invoice and kind only', async () => {
  const { broker, make } = setup();
  const a = make('INV-2');
  const r = make('INV-2', 'send_reminder');
  const b = make('INV-2');
  const other = make('INV-5');
  assert.equal(broker.get(a.id)!.status, 'superseded');
  assert.equal(broker.get(r.id)!.status, 'pending');
  assert.equal(broker.get(b.id)!.status, 'pending');
  assert.equal(broker.get(other.id)!.status, 'pending');
  await assert.rejects(broker.approve(a.id, a.payload_hash), code('ALREADY_RESOLVED'));
});

test('execution failure marks the card failed; reject is audited', async () => {
  const { broker, audit, make } = setup();
  const f = make('INV-1', 'send_reminder', true);
  await assert.rejects(broker.approve(f.id, f.payload_hash), code('CANNOT_REMIND_INVOICE'));
  assert.equal(broker.get(f.id)!.status, 'failed');
  const r = make('INV-3');
  broker.reject(r.id, 'not now');
  assert.equal(broker.get(r.id)!.status, 'rejected');
  assert.deepEqual(audit.find('confirmation.rejected').map((e) => e.details.reason), ['not now']);
  assert.equal(audit.find('confirmation.failed').length, 1);
});

test('audit entries are append-only and frozen', () => {
  const audit = new AuditLog();
  const e = audit.append('owner', 'x', { a: 1 });
  assert.equal(e.seq, 1);
  assert.throws(() => { (e as { action: string }).action = 'y'; });
});
