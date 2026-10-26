# PayPal Invoicing facts for tranches (verified 2026-10-17; sandbox-client section 2026-10-25; real-sandbox answers 2026-10-26)

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
- "Payment arrives": `POST …/payments` (record external payment) → `PAID`/`PARTIALLY_PAID` per INV:745. **Real sandbox 2026-10-26: a full external payment gives `MARKED_AS_PAID`** (§9).
- "Refund": `POST …/refunds` (record external refund) → `REFUNDED`/`PARTIALLY_REFUNDED` per INV:1008.
- A *real* PayPal-wallet payment of an invoice requires the payer to log in to the PayPal-hosted invoice page with a sandbox personal account (browser). Not needed for the demo.

## Credentials status
- 2026-10-17 and 2026-10-25: `~/.config/tillwise/paypal-sandbox.env` absent; mock only.
- **2026-10-26: the file holds PayPal's default PUBLIC sandbox credentials** (written by the user; the same values
  that `npm run sandbox:use-public-creds` fetches — compared programmatically, not printed). Source:
  https://github.com/paypal/postman-collections, `Collections/PayPal_Public_APIs.json`, collection variables
  `client_id` / `client_secret`. The collection's own variable `PLEASE NOTE -->` says, verbatim: "PayPal Public
  Collection comes with following default public set of credentials stored at the Collection level. You may choose
  to override these values via environment level variables. You may bring your own credentials from PayPal
  Developer Dashboard there."
- Their token response carries `app_id` **APP-80W284485P519543T** (`PUBLIC_DEFAULT_APP_ID` in
  `src/paypal/sandboxClient.ts`; the UI and CLIs say "PayPal public default credentials (shared)" when they see it).
  It is a **shared** app: everything created with it is visible to other users of these credentials, so every
  Tranche set uses fake names, `@example.com` recipients and its own `TR-XXXXX-` invoice-number prefix.
- The values are never printed, logged or committed. A scan of every tracked/untracked file for the id, the secret
  and their Basic base64 found 0 hits before committing.
- The default is still the deterministic `MockInvoicingClient`; `TRANCHE_PAYPAL=sandbox` switches to the client below.
  It was **written fresh** for Tranche (nothing copied from entry 1).

## Sandbox client (M4-prep, `src/paypal/sandboxClient.ts`) — sources for every request shape
Status: unit-tested against a local stub server (`test/unit/helpers/paypalStub.ts`, now aligned with the real answers
in §9) and, **since 2026-10-26, run against api-m.sandbox.paypal.com**: `sandbox:smoke` (5/5), `sandbox:seed`
(twice, idempotent), the fact probe (§9) and the opt-in real-UI e2e `npm run test:sandbox-live` (1/1). Every request
is in the call ledger `artifacts/sandbox/paypal-calls.jsonl` (method, path, status, duration, PayPal-Debug-Id; no
headers or bodies).

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

Every Tranche invoice number carries a prefix: `npm run sandbox:seed` generates `TR-XXXXX-` and saves it in
`.tranche/sandbox-state.json` (git-ignored; `TRANCHE_INVOICE_PREFIX` overrides, fallback `TRANCHE-`). Because the
real `search_data.invoice_number` is a prefix match (§9), every search sends the prefix, so Tranche never pages
through, reads or changes other people's invoices in a shared sandbox app; results without the prefix are dropped too.

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
(`TRANCHE_POLL_MS`; minimum **30 s against the real sandbox**, 5 s only for the loopback stub). A poll costs one
search; a paid/refunded invoice costs one extra GET the first time its status changes (§9, search shape). Demo
controls trigger one immediate poll. The header badge reads **`PayPal: REAL SANDBOX API`** against
api-m.sandbox.paypal.com (its tooltip and the PayPal-events header show the app id or "PayPal public default
credentials" when `app_id` is APP-80W284485P519543T, plus the invoice prefix); against the loopback stub it reads
`PayPal: SANDBOX API · local stub`.

### 6. Demo states in a real sandbox (`npm run sandbox:seed`)
| Demo state | How the seed reaches it | Evidence / status |
|---|---|---|
| INV-3 `DRAFT` | create only | INV:100 "Creates a draft invoice." |
| INV-2, INV-5 sent | create, then `send` with `send_to_recipient: false, send_to_invoicer: false` (share-link send, no email to the fictional `@example.com` recipients) | INV:340 "To send the invoice through a share link and not through PayPal, set the `send_to_recipient` parameter to `false`". **Real sandbox: status `UNPAID`** (§9). |
| INV-1, INV-4 paid | create, send, then `POST …/payments` (method `BANK_TRANSFER`, the mock payment date) | **Real sandbox: status `MARKED_AS_PAID`**, transaction `type: EXTERNAL` (§9). Counts as paid. No sandbox buyer or browser is needed. |
| INV-2 "9 days overdue" | due date 2026-10-25 (from the mock data); overdue is computed against the **demo clock** `TRANCHE_TODAY` (default 2026-11-03), shown as the "Demo today" pill | PayPal has no OVERDUE status (enum above), so overdue is always our computation. |
| Issue dates in the future (INV-3 2026-11-08) | clamped to the real date before create | INV:340: a future issue date makes `/send` *schedule* the invoice instead of sending it. |
| Past `due_date` | sent as-is | **Real sandbox: accepted** — create with `due_date` 2026-10-17 on 2026-10-26 returned `status: DRAFT`, `due_date: 2026-10-17`, `term_type: DUE_ON_DATE_SPECIFIED` (§9). The `DUE_ON_RECEIPT` + `due=` tag fallback stays in the code (unit-tested with a stub knob) but was not needed. |
| INV-2 paid on 3 Nov (demo) | "Record bank transfer" → `POST …/payments` dated on the demo clock (2026-11-03, after the real date) | **Real sandbox: a future `payment_date` is accepted** (§9). |

Idempotency: each invoice is first looked up by its prefixed `invoice_number` and only created if missing; existing
invoices only move forward (DRAFT → sent → paid). One prefix-scoped search covers all five. A sandbox invoice that is
"ahead" of the demo (e.g. INV-2 paid during a rehearsal) is reported as `DRIFT` and left alone; run
`npm run sandbox:seed -- --fresh` for a new set with a new prefix. Real run: first seed 20 requests, rerun 9 requests
with every row `found` (`artifacts/sandbox/seed-2026-10-26*.txt`). Payments from the demo controls use the demo date
(verified accepted); refunds are still clamped to the real date (a future refund date is unverified).

### 7. Not possible without a browser
"Client pays via PayPal" needs a sandbox **buyer** to open the invoice link and pay in a browser. In sandbox mode
that demo button is disabled, the API answers `409 NEEDS_BROWSER_PAYER`, and a visible note under the demo controls
says: "A real PayPal payment needs a sandbox buyer paying the invoice link in a browser, so this demo records the
payment through the Invoicing API ("Record bank transfer")." Tranche itself never logs in as a buyer.

### 8. Still unverified
- A **refund** dated in the future (`/refunds` with a date after the real date); the app clamps refunds to the real date.
- Status after `send` **with** `send_to_recipient: true` (SENT?). Tranche only uses share-link sends.
- `PARTIALLY_PAID` / `PAYMENT_PENDING` produced by the real sandbox (only via the stub).
- A real PayPal-wallet payment by a sandbox buyer (needs a browser; not done).
- Webhooks (not used; polling only).
- Whether the public default credentials stay available and unchanged (PayPal can rotate them at any time).

### 9. Real-sandbox answers (2026-10-26, api-m.sandbox.paypal.com, app APP-80W284485P519543T)
Evidence: `artifacts/sandbox/probe-2026-10-26-9112L.json` (`npm run sandbox:probe`, 13 requests, prefix `TRP-9112L-`,
fake recipient `probe@example.com`), `artifacts/sandbox/search-shape-2026-10-26.json`, the ledger
`artifacts/sandbox/paypal-calls.jsonl`, and the live e2e evidence `artifacts/sandbox/sandbox-live-flow.json`.

| Question | Real answer (quoted from the evidence) |
|---|---|
| Past `due_date` accepted at create? | **Yes.** Sent `2026-10-17` on 2026-10-26 → `"status": "DRAFT", "returned_due_date": "2026-10-17", "returned_term_type": "DUE_ON_DATE_SPECIFIED", "representation_returned": true` |
| `Prefer: return=representation` returns the invoice? | **Yes** (`representation_returned: true` above). |
| Duplicate `invoice_number`? | **Rejected:** `422 DUPLICATE_INVOICE_NUMBER [/detail/invoice_number]: Invoice number is duplicate. (PayPal-Debug-Id f149106fa06b9)` |
| `search_data.invoice_number` exact or partial? | **Prefix (starts-with):** full number → `total_items: 1`; prefix only (`TRP-9112L-`) → `total_items: 1`; a middle substring → `total_items: 0`. |
| Status after share-link `send` (`send_to_recipient: false`)? | **`UNPAID`** (`"status after send": {"status": "UNPAID"}`) |
| `remind` on that invoice? | Accepted (`ok`). |
| Future `payment_date` on `/payments`? | **Accepted:** dated 2026-11-03 on 2026-10-26 → `"payment_id": "EXTR-8FG253960X465120G"` |
| Status after recording a full external payment? | **`MARKED_AS_PAID`**, transaction `{"payment_date": "2026-11-03", "method": "BANK_TRANSFER", "type": "EXTERNAL"}` |
| Cancel a paid invoice? | **Rejected:** `422 CANNOT_CANCEL_PAID_INVOICE [invoiceId]: Cannot cancel a paid or partially paid invoice. (PayPal-Debug-Id f893957abbd7d)` — paid demo invoices therefore stay in the shared app. |
| What does a search item contain? | Keys `amount, detail, due_amount, id, links, payments, primary_recipients, status, unilateral`; for a `MARKED_AS_PAID` invoice `payments` has **only `paid_amount`** — no `transactions`, so no payment date (`search-shape-2026-10-26.json`). Tranche therefore GETs a paid/refunded invoice once per status change (cached). |
| Transient errors? | Seen once: `GET /v2/invoicing/invoices/INV2-XRFP-…` → **503** at 13:09:47.955Z, retried by the client → 200 at 13:09:49.318Z (ledger). |
| DELETE a draft / cancel an unpaid invoice? | `DELETE` → 204; `POST …/cancel` (`send_to_recipient: false`) → 204 (ledger, live-e2e cleanup). |
| Can an access token stop working before `expires_in`? | **Yes, once (video recording, 2026-10-26).** Token fetched 13:26:41Z; at 13:30:52Z `search-invoices` → `401 invalid_token: Access Token not found in cache (PayPal-Debug-Id f868105cdf957)`. The client dropped the token, fetched a new one (13:30:52.945Z, 200) and retried → 200 (ledger lines 175–177; code `src/paypal/sandboxClient.ts:280`, test "OAuth: one 401 on an API call fetches a new token and retries once"). Cause unknown (shared public app). |
| How fast is `search-invoices`? | **Slow during the recording:** 14.9–19.8 s per call for a 5-invoice prefix (ledger `ms`, lines 165–192, 13:27–13:37Z); GET/POST on a single invoice took 0.3–0.7 s. This is why the PAID event shows up 15–20 s after *Record bank transfer*: the next search has to finish first. |

Fixes made because of these answers: prefix-scoped search; `UNPAID`/`MARKED_AS_PAID` in the stub and tests; the stub's
search now strips `transactions` like the real API; a detail GET for paid/refunded invoices; demo payments dated on the
demo clock; per-set prefixes (duplicates are rejected, so a rerun can never create a second `INV-2`).
