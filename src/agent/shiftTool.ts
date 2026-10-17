import { defineTool } from '@github/copilot-sdk';
import { DEMO_TODAY, MOCK_INVOICES, PROJECTS } from '../domain/mockData.ts';
import { previewShift, ShiftPreviewError } from '../domain/schedule.ts';
import type { ShiftPreview, ShiftPreviewInput } from '../domain/types.ts';

export type ShiftToolCall = { args: unknown; result?: ShiftPreview; error?: { code: string; message: string } };

// Read-only tool: the model chooses the invoice and an assumed payment date; OUR code computes every date.
export function createShiftPreviewTool(log: ShiftToolCall[], ctx = { projects: PROJECTS, invoices: MOCK_INVOICES, today: DEMO_TODAY }) {
  return defineTool<ShiftPreviewInput & { reason?: string }>('schedule_shift_preview', {
    description: 'Preview (never apply) how a late, failed or refunded PayPal invoice tranche shifts the dependent project phases on the delivery Gantt. Returns the dependent tasks with old and new dates computed by the scheduler.',
    parameters: {
      type: 'object',
      properties: {
        invoice_number: { type: 'string', description: 'PayPal invoice number of the tranche, e.g. "INV-2".' },
        assumed_payment_date: { type: 'string', description: 'YYYY-MM-DD date you assume the payment will arrive (must be today or later). Omit to use the policy default of today + 7 days.' },
        reason: { type: 'string', description: 'Short reason, e.g. "overdue 9 days".' },
      },
      required: ['invoice_number'],
      additionalProperties: false,
    },
    skipPermission: true,
    handler: (args) => {
      const entry: ShiftToolCall = { args };
      log.push(entry);
      try {
        entry.result = previewShift(args, ctx);
        return JSON.stringify({ ok: true, applied: false, ...entry.result });
      } catch (err) {
        const e = err instanceof ShiftPreviewError ? err : new ShiftPreviewError('INTERNAL', String(err));
        entry.error = { code: e.code, message: e.message };
        return JSON.stringify({ ok: false, error: entry.error });
      }
    },
  });
}
