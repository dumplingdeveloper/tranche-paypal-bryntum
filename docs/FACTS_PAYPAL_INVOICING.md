# PayPal Invoicing facts for tranches (verified 2026-10-17)

Spec files: `/Users/shiyx/.copilot/session-state/a5f98933-0ac2-4012-8b8b-91ed009d4889/files/paypal-rest-api-specifications/openapi/`
(`invoicing_v2.json` = **INV**, `notifications_webhooks_v1.json` = **WH**). Line numbers refer to those files.

## Operations we need
| Purpose | Endpoint | Spec evidence |
|---|---|---|
| Create tranche (draft) | `POST /v2/invoicing/invoices` | INV:97–101; :100 "Creates a draft invoice. To move the invoice from a draft to payable state, you must send the invoice." |
| Send / schedule | `POST /v2/invoicing/invoices/{invoice_id}/send` | INV:337–341; :340 "Sends or schedules an invoice … If the invoice issue date is in the future, schedules the invoice to be sent on that date." Body = `notification` (INV:461) |
| Reminder | `POST /v2/invoicing/invoices/{invoice_id}/remind` | INV:477–481; :480 "Sends a reminder to the payer about an invoice … API caller can send only 2 reminders in a day." Body = `notification` (INV:616) |
| Cancel | `POST /v2/invoicing/invoices/{invoice_id}/cancel` | INV:632–636; :635 "Cancels a sent invoice, by ID, and, optionally, sends a notification about the cancellation…" Body = `notification` (INV:725) |
| Record payment (no payer needed) | `POST /v2/invoicing/invoices/{invoice_id}/payments` | INV:742–746; :745 "Records a payment for the invoice. If no payment is due, the invoice is marked as `PAID`. Otherwise, the invoice is marked as `PARTIALLY PAID`." Body = `payment_detail` (INV:893) |
| Record refund (no payer needed) | `POST /v2/invoicing/invoices/{invoice_id}/refunds` | INV:1005–1009; :1008 "Records a refund for the invoice. If all payments are refunded, the invoice is marked as `REFUNDED`. Otherwise, the invoice is marked as `PARTIALLY REFUNDED`." |
| Undo external payment/refund | `DELETE …/payments/{transaction_id}`, `DELETE …/refunds/{transaction_id}` | INV:910–914, 1173–1177 |
| Poll | `GET /v2/invoicing/invoices` (list), `GET …/{invoice_id}` (show), `POST /v2/invoicing/search-invoices` | INV:231–233, 1440–1444, 1767–1771; search filters incl. `status` (INV:6802), `invoice_date_range` (:6827), `due_date_range` (:6831) |
| Next number | `POST /v2/invoicing/generate-next-invoice-number` | INV:1370–1374 |

## Invoice statuses (INV:3868–3958, `invoice_status`)
`DRAFT` "not yet sent to the payer" · `SENT` "The payment is awaited from the payer." · `SCHEDULED` · `PAID` "The payer has paid for the invoice." · `MARKED_AS_PAID` "marked as paid by the invoicer" · `CANCELLED` · `REFUNDED` · `PARTIALLY_PAID` · `PARTIALLY_REFUNDED` · `MARKED_AS_REFUNDED` · `UNPAID` · `PAYMENT_PENDING` "under pending review" · `AUTO_CANCELLED` "automatically cancelled because the payment was not received within the specified timeframe" · `PAID_EXTERNAL` · `REFUNDED_EXTERNAL` · `SHARED`.

Tranche mapping used in `src/domain/schedule.ts`: paid = `PAID | MARKED_AS_PAID | PAID_EXTERNAL`; shiftable (money still expected or taken back) = the DRAFT/SENT/SCHEDULED/UNPAID/PARTIALLY_PAID/PAYMENT_PENDING/SHARED/REFUNDED family.
**There is no "OVERDUE" status** — overdue is derived by us from `detail.payment_term.due_date` (INV:3860, `invoice_payment_term.due_date`) vs today. Payment terms enum `payment_term_type`: `DUE_ON_RECEIPT`, `DUE_ON_DATE_SPECIFIED`, `NET_10`, `NET_15`, `NET_30`, … (INV:6461–6466 and `payment_term_type` schema).

## Reminder text caveat (important for the "friendly reminder" feature)
`notification` schema (used by send/remind/cancel):
- INV:6298 `subject`: "User-provided values for this field will not be honored and the subject will always be defaulted to a system-defined value."
- INV:6305 `note`: "User-provided values for this field will not be honored and the note will always be defaulted to a system-defined value."
- INV:6310–6319 `send_to_invoicer` (default false), `send_to_recipient` (default true).

→ The AI-drafted friendly wording **cannot** be delivered through the PayPal reminder itself (per spec). Design: PayPal sends its standard reminder (`/remind`), and the agent's friendly text is shown to the owner to copy/send by email, or set as the invoice's `detail.note` *before* sending (draft update). UNVERIFIED in sandbox whether `detail.note` edits are allowed on a SENT invoice.

## Record payment body (`payment_detail`)
- `type` `PAYPAL | EXTERNAL` ("an external cash or a check payment"), readOnly.
- `payment_date` (INV:6358) "The date when the invoice was paid".
- `method` (INV:6362) → `payment_method` enum (INV:6394): `BANK_TRANSFER, CASH, CHECK, CREDIT_CARD, DEBIT_CARD, PAYPAL, WIRE_TRANSFER, OTHER`.
- `note` (INV:6366) "A note associated with an external cash or check payment."

## Webhooks vs polling
- Event names (https://developer.paypal.com/api/rest/webhooks/event-names/, fetched 2026-10-17): `INVOICING.INVOICE.CANCELLED` "A merchant or customer cancels an invoice." · `INVOICING.INVOICE.CREATED` · `INVOICING.INVOICE.PAID` "An invoice is paid, partially paid, or payment is made and is pending." · `INVOICING.INVOICE.REFUNDED` "An invoice is refunded or partially refunded." · `INVOICING.INVOICE.SCHEDULED` · `INVOICING.INVOICE.UPDATED`.
  There is **no** "invoice overdue" webhook → overdue must come from polling/our clock.
- Simulator: `POST /v1/notifications/simulate-event` (WH:741–745), schema `simulate_event` requires `event_type`; `webhook_id` or `url`. WH:42: "The events that this call generates only serve to validate the connection to the listener URL and to show how webhook events look." → simulated events are samples, not tied to our invoices.
- Verify signature: `POST /v1/notifications/verify-webhook-signature` (WH:467).
- Webhook `url` field (WH:1699–1702, schema `webhook.url`): "The URL that is configured to listen on `localhost` for incoming `POST` notification messages". A judge's laptop is not reachable from PayPal, so **judge path = polling** (`search-invoices` every N seconds in sandbox mode) + an in-app "event feed" that normalises polled diffs into the same event shape as webhooks. Webhook receiver is optional for a hosted deployment.

## What can be automated without a browser payer (sandbox)
- Create → send → remind → cancel: merchant-side API calls only.
- "Payment arrives": `POST …/payments` (record external payment) → `PAID`/`PARTIALLY_PAID` per INV:745. Whether the resulting status is `PAID` or `MARKED_AS_PAID` for an external payment is UNVERIFIED (both exist in the enum).
- "Refund": `POST …/refunds` (record external refund) → `REFUNDED`/`PARTIALLY_REFUNDED` per INV:1008.
- A *real* PayPal-wallet payment of an invoice requires the payer to log in to the PayPal-hosted invoice page with a sandbox personal account (browser). Not needed for the demo.

## Credentials status
`~/.config/tillwise/paypal-sandbox.env` is **absent** (checked 2026-10-17). Design is **mock-first**: a deterministic `MockInvoicingClient` (same method surface) is the default; `LiveInvoicingClient` (sandbox host only, adapted from entry 1's `liveClient.ts` OAuth + `paypalFetch` pattern) is enabled only when credentials exist.
