# PayPal Invoicing facts for tranches (verified 2026-10-17; sandbox-client section 2026-10-25)

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
`~/.config/tillwise/paypal-sandbox.env` is **absent** (checked 2026-10-17 and again 2026-10-25). The default is the
deterministic `MockInvoicingClient`. The sandbox client below (M4-prep, 2026-10-25) was **written fresh** for Tranche
(nothing copied from entry 1) and is enabled only with `TRANCHE_PAYPAL=sandbox` **and** credentials.

## Sandbox client (M4-prep, `src/paypal/sandboxClient.ts`) — sources for every request shape
Status: unit-tested against a local stub server shaped from the spec (`test/unit/helpers/paypalStub.ts`) and through
the real UI against that stub (`test/e2e/sandbox.e2e.ts`). **It has never been run against api-m.sandbox.paypal.com**
(no credentials). No PayPal network call was made while building it.

### 1. Host and auth
| What | Source |
|---|---|
| Sandbox base URL `https://api-m.sandbox.paypal.com` | INV:11 (`servers[0].url`) |
| OAuth2 client_credentials, token URL `/v1/oauth2/token` | INV:2555–2557 (`flows.clientCredentials.tokenUrl`) |
| Request shape: Basic auth `client_id:secret`, `Content-Type: application/x-www-form-urlencoded`, body `grant_type=client_credentials` | https://developer.paypal.com/api/rest/authentication/ — cURL sample: `curl -v -X POST "https://api-m.sandbox.paypal.com/v1/oauth2/token" -u "CLIENT_ID:CLIENT_SECRET" -H "Content-Type: application/x-www-form-urlencoded" -d "grant_type=client_credentials"` |
| Cache until expiry | same page: "PayPal returns an access token and the number of seconds the access token is valid." … "When your access token expires, call `/v1/oauth2/token` again to request a new access token." Sample response has `"expires_in": 31668`. We cache until `expires_in − 60 s`, share one in-flight token request, and on a 401 refetch once. |

The client refuses any base URL other than the sandbox host (loopback is allowed only so the stub tests can run);
`api-m.paypal.com` (live, INV:15) is rejected in the constructor.

### 2. Endpoints used
| Method | Endpoint | Spec |
|---|---|---|
| `createDraft` | `POST /v2/invoicing/invoices` with `Prefer: return=representation` | INV:97–101; INV:104 "A JSON response body that shows invoice details is returned if you set `prefer=return=representation`." Without it the client follows the returned link with a GET. |
| `getInvoice` | `GET /v2/invoicing/invoices/{invoice_id}` | INV:1440–1444; `invoice_id` pattern `^(INV2-)[A-Z0-9\-]{19}$` (INV:3844) |
| `listInvoices` | `GET /v2/invoicing/invoices?page&page_size&total_required` | INV:230–233 "List invoices"; parameters INV:313–324 |
| `searchInvoices` | `POST /v2/invoicing/search-invoices?page&page_size=100&total_required=true`, body `search_data` | INV:1767–1771; `invoice_number` INV:6795, `status` INV:6802; response `invoices` (INV:4012: `total_pages`, `items`) |
| `sendInvoice` | `POST …/{id}/send`, body `notification` | INV:337–341 |
| `remindInvoice` | `POST …/{id}/remind` → 204 | INV:477–481; INV:480 "API caller can send only 2 reminders in a day." |
| `cancelInvoice` | `POST …/{id}/cancel` → 204 | INV:632–636 |
| `recordPayment` | `POST …/{id}/payments`, body `payment_detail` → `payment_reference` | INV:742–746, `payment_detail` INV:6341 (`method` required), `payment_reference` INV:6446 |
| `recordRefund` | `POST …/{id}/refunds`, body `refund_detail` → `refund_reference` | INV:1005–1009, INV:6682, INV:6725 |
| `deleteDraft` (smoke cleanup only) | `DELETE /v2/invoicing/invoices/{id}` → 204 | INV:1694–1696: "Deletes invoices in the draft or scheduled state only." |

Draft body fields: `detail.invoice_number` (max 25, INV:3795–3798), `detail.reference` (INV:3116, max 120),
`detail.currency_code`, `detail.invoice_date`, `detail.payment_term.due_date` (INV:3860; "either but not both
`term_type` or `due_date`", INV:3806), `primary_recipients[].billing_info.business_name/email_address`
(INV:2849, INV:2979), `items[].name/quantity/unit_amount` (INV:6062).

Every Tranche invoice number is prefixed `TRANCHE-` (configurable with `TRANCHE_INVOICE_PREFIX`), and every search
result without that prefix is dropped, so Tranche never reads or changes other invoices in a shared sandbox account.

### 3. Status mapping (`toDomainStatus`, `toDomainInvoice`)
The domain keeps PayPal's own enum (INV:3868–3958), so nothing is lost. `src/domain/schedule.ts:5` treats
`PAID | MARKED_AS_PAID | PAID_EXTERNAL` as paid; `PAYMENT_PENDING` ("under pending review") and `PARTIALLY_PAID`
are **not** paid, so the dependent phase stays blocked. An unknown future status maps to `UNPAID` (money still
expected). **Overdue is derived**: there is no OVERDUE status in the enum, so
`daysOverdue = today − detail.payment_term.due_date` for unpaid invoices (`schedule.ts:29`).
If PayPal stores no due date (e.g. `DUE_ON_RECEIPT`), the due date is read from a `due=YYYY-MM-DD` tag in
`detail.reference`, else the invoice date.

### 4. Errors, retries, idempotency
- Error body `error_default` (INV:3506): `name`, `message`, `debug_id` (INV:3206), `details[]`. Docs
  (https://developer.paypal.com/api/rest/responses/): "For all errors except Identity errors, PayPal returns an
  error response body that includes additional error details in this format. `{ "name": "ERROR_NAME", "message":
  "Error message.", "debug_id": "debug_ID", "details": [ { "field": "field_name", "value": "value_passed",
  "location" …`". The client builds `InvoicingError(status, details[0].issue, message)` with the field, and logs
  the `PayPal-Debug-Id` response header (or `debug_id`).
- Same page: "`429 Too Many Requests` `RATE_LIMIT_REACHED`. Too many requests. Blocked due to rate limiting."
  and "`503 Service Unavailable` … temporary maintenance."
- Retry policy: 429 is retried for every call (the request was refused, not processed), honouring `Retry-After`,
  else exponential backoff 500 ms × 2ⁿ, max 3 retries. 5xx and network errors are retried only for reads
  (GET and search).
- Why POST mutations are **not** retried on 5xx: the idempotency header is per API. https://developer.paypal.com/api/rest/requests/:
  "PayPal-Request-Id Optional. See the API reference to verify the API supports this header."
  https://developer.paypal.com/api/rest/reference/idempotency/: "Note: Not all APIs support this header."
  `grep -ci request-id invoicing_v2.json` → `0`: the Invoicing spec does not declare it, so a blind retry of
  e.g. `/payments` could record a payment twice.
- Secrets: `mask()` replaces the client id, the secret, their Basic-auth base64 and every access token the client
  has held with `***` in every log line and error. A unit test makes the stub echo all four back and checks that
  none appear in logs, errors or the `calls` log.

### 5. Mode switch and polling
`TRANCHE_PAYPAL=sandbox npm start` (the older `TRANCHE_PAYPAL_MODE` is still accepted). Credentials come from env
`PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`, else `~/.config/tillwise/paypal-sandbox.env`; a file readable by others
produces a `chmod 600` warning. With no credentials, start, seed and smoke all print `NO CREDENTIALS: …` and exit 2
before any request. A unit test runs all three as child processes with `HOME` set to an empty temp dir and a
preloaded spy on `fetch` and `net.Socket#connect` (with a positive control showing the spy does record a request);
it asserts exit 2 and an empty spy log.
There is no local webhook receiver (see "Webhooks vs polling"), so the watcher polls `search-invoices` every 30 s
(`TRANCHE_POLL_MS`, minimum 5 s). The header badge reads `PayPal: SANDBOX`; when the base URL is the loopback stub
it reads `PayPal: SANDBOX API · local stub`.

### 6. Demo states in a real sandbox (`npm run sandbox:seed`)
| Demo state | How the seed reaches it | Evidence / status |
|---|---|---|
| INV-3 `DRAFT` | create only | INV:100 "Creates a draft invoice." |
| INV-2, INV-5 `SENT` | create, then `send` with `send_to_recipient: false, send_to_invoicer: false` (share-link send, no email to the fictional `.example` recipients) | INV:340 "To send the invoice through a share link and not through PayPal, set the `send_to_recipient` parameter to `false`". Resulting status (SENT vs UNPAID) is **unverified**; both are treated as "money expected". |
| INV-1, INV-4 `PAID` | create, send, then `POST …/payments` (method `BANK_TRANSFER`, mock payment date) | INV:745 "If no payment is due, the invoice is marked as `PAID`." Whether the real sandbox reports `PAID` or `MARKED_AS_PAID` is **unverified**; both count as paid. No sandbox buyer or browser is needed. |
| INV-2 "9 days overdue" | due date 2026-10-25 (from the mock data); overdue is computed against the **demo clock** `TRANCHE_TODAY` (default 2026-11-03), shown as the "Demo today" pill | PayPal has no OVERDUE status (enum above), so overdue is always our computation. |
| Issue dates in the future (INV-3 2026-11-08) | clamped to the real date before create | INV:340: a future issue date makes `/send` *schedule* the invoice instead of sending it. |
| Past `due_date` | sent as-is; **if PayPal rejects it** (a 4xx whose issue/field mentions the due date), the seed recreates the draft as `DUE_ON_RECEIPT` with `reference: "tranche-demo/v1 due=2026-10-25"`, and Tranche reads the planned due date from that tag | **Unverified.** The spec does not say whether a past `due_date` is accepted. A web search returned an AI-written answer claiming it is rejected, but its only cited source (a Stack Overflow question about payment terms) could not be opened (HTTP 403), so I do not rely on it. The fallback path is unit-tested with a stub knob. |

Idempotency: each invoice is first looked up by its prefixed `invoice_number` and only created if missing; existing
invoices only move forward (DRAFT → sent → paid). A sandbox invoice that is "ahead" of the demo (e.g. INV-2 paid
during a rehearsal) is reported as `DRIFT` and left alone; set `TRANCHE_INVOICE_PREFIX=TR2-` to seed a fresh set.
Demo controls in sandbox mode never send a payment/refund date later than the real date.

### 7. Not possible without a browser
"Client pays via PayPal" needs a sandbox **buyer** to open the invoice link and pay in a browser. In sandbox mode
that demo button is disabled and the API answers `409 NEEDS_BROWSER_PAYER`; "Record bank transfer" (`/payments`)
is the API-only path.

### 8. Unverified (needs a real sandbox run)
- Every request above against the real sandbox (only the stub has been exercised).
- Whether a past `due_date` is accepted at create time.
- Status after `send` with `send_to_recipient: false` (SENT vs UNPAID), and after a recorded external payment
  (PAID vs MARKED_AS_PAID).
- Whether `search_data.invoice_number` is an exact or partial match (the client filters exactly, client-side).
- Whether PayPal rejects a duplicate `invoice_number` (the seed avoids duplicates by searching first).
- Whether `Prefer: return=representation` returns the full invoice in the sandbox (the link fallback is tested).
- A future `payment_date` / `refund_date` being rejected (the app clamps to the real date anyway).
