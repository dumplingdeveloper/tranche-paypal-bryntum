import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type AuditActor = 'owner' | 'agent' | 'paypal' | 'browser' | 'system' | 'demo-control';
export type AuditEntry = { seq: number; at: string; actor: AuditActor; action: string; details: Record<string, unknown> };

// Append-only audit trail. Optionally mirrored to a JSONL file (TRANCHE_AUDIT_FILE).
export class AuditLog {
  readonly entries: AuditEntry[] = [];
  private listeners: Array<(e: AuditEntry) => void> = [];
  private file?: string;
  constructor(file?: string) { this.file = file; if (file) mkdirSync(dirname(file), { recursive: true }); }

  append(actor: AuditActor, action: string, details: Record<string, unknown> = {}): AuditEntry {
    const entry: AuditEntry = Object.freeze({ seq: this.entries.length + 1, at: new Date().toISOString(), actor, action, details: structuredClone(details) }) as AuditEntry;
    this.entries.push(entry);
    if (this.file) appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    for (const l of this.listeners) l(entry);
    return entry;
  }

  onAppend(fn: (e: AuditEntry) => void) { this.listeners.push(fn); }
  find(action: string) { return this.entries.filter((e) => e.action === action); }
}
