# Changelog

Notable changes to Sail, newest first. Field and operation names are as in `packages/server/openapi.json`.

## Unreleased

### Payment providers
- A payment-provider interface (`PaymentProvider`): start a payment on a terminal, read it, cancel it, void it, and verify and parse a webhook. A tender with `provider` and `terminal_id` sends its payments to that terminal; every other tender is recorded by hand as before, and a provider tender can no longer be recorded by hand.
- Payment intents. `payments.start` pins the bill and the amount and tip, writes the intent and an outbox row, and returns at once; the worker calls the provider; the outcome, by webhook or by the worker's poll, is recorded through the ordinary payment path exactly once. An approval for a bill that changed or was paid another way, for a different amount, or after the intent was cancelled or expired (120 s) is voided at the provider and never applied. New operations `payments.start`, `payments.cancel` and `payment_intents.list`, and `payment_intent.*` events.
- An outbox with per-row retries and backoff: a failing provider call never holds up the others, and gives up after 8 attempts.
- Webhooks at `/v1/webhooks/payments/{provider}/{merchant_id}`, verified with the merchant's secret (`payment_providers.configure`), refused when stale, applied once per event id and rate-limited per merchant (verified and refused deliveries counted apart).
- `payments.void` (T3, Manager+ or a manager's approval bound to the payment): reverses a payment recorded in error while its shift is open, its business day is not closed and nothing has been refunded from the bill. A terminal payment is voided at the provider first. An agent's void is a proposal. While a void waits for the provider, refunds on the order and the shift and business-day closes wait too; an order paid on a terminal cannot be reopened.
- A terminal simulator (`pnpm --filter @sail/server sim:payments`, started by `dev:local`) with approve, decline, timeout, duplicate and late outcomes, and a "Card (terminal)" demo tender. The POS pay screen sends a payment to the terminal, waits for the answer on the event stream, and voids a recorded payment.

### Any country by configuration
- Tax classes and rates per merchant. A rate is a list of named components (state and local sales tax, VAT, consumption tax) and can be scoped to an outlet, an order type or both; an empty list is exempt. Tax rounds per line or once per rate (`tax_rounding`). New operations `tax_classes.list`, `tax_classes.create`, `tax_classes.update`, `tax_rates.set` and `tax_rates.delete`, and a Settings > Tax classes screen.
- Region presets (`sg`, `us`, `eu-vat`, `jp`, `blank`) chosen when a merchant is created: currency, locale, tax classes and rates, service charge and deposit rules, tenders, cash denominations and registration labels. `bootstrap` takes `--preset` and `--time-zone`, both required. `dev:local` creates a second demo merchant, a café with inclusive VAT at 20% and 10% in EUR.
- Currency, locale and time zone come from the merchant's settings everywhere, with no defaults: amounts use the currency's exponent (`currency_exponent`), `formatMoney` and `parseMoney` take the currency and locale, and guest sessions and digital receipts carry both. Pricing-rule and other date inputs use the merchant's time zone.
- Renamed: `gst_*` fields to `tax_*`, `is_bcrs` to `has_deposit` (and the `bcrs` rule scope to `deposit`), an outlet's `uen` to `business_registration_no` plus a new `tax_registration_no`. Removed: `gst_bps` and the `GST_BPS` environment variable. Every place with a tax figure also has `taxes`, the breakdown by component.
- `cash_variance_threshold` is a merchant setting, and `shifts.close` refuses a larger variance without a reason (it was a constant in the POS).
- Net sales exclude tax and fees and subtract the refunds' net in every report.
- A refund by amount reverses a share of what is left on each line, not of the line as sold.
- CSV import reads prices with the currency's decimals, refuses a comma that does not group thousands, and takes a `tax_class` column.
- Back-office Sales, Items and Print-health report views. The guest menu hides open-price items.
- Reference set at 162 pricing cases, adding US, EU, Japanese, three-decimal and cash-rounding cases.

### Security
- A manager approval (override grant) covers exactly what the manager approved: the void quantity, open price, rule and entered value, payment or refund and its total. It is bound to the requester's PIN session and station, spent once by a conditional update, and its id is returned only to the requester. A manual rule's own minimum role decides who may approve it.
- Wrong manager-approval PINs count towards the station's lockout with sign-in PINs, and each attempt is counted before it is checked. The PIN lockout and the guest rate limits are stored in Postgres, so they hold across API machines.
- A proposal stores the order's version and total and executes only on the order the approver saw.
- An agent never runs a T2 operation (send to the kitchen, record a payment, apply a discount or comp) by itself, whatever its ceiling: each one is a proposal.
- Free-text fields are marked in the spec (`x-sail-untrusted`), and the MCP adapter wraps every one of them for agents.
- Tenders have `requires_approval` (a Cashier needs a Manager or a Manager's PIN for that payment and its reference) and `requires_reference`. Approval is on by default for a tender that is neither cash nor a card terminal, and a migration switches it on for existing ones.
- With hold orders off, a round fires at once only from the seating's first phone or a phone staff have accepted a round from; another phone's round waits for staff.
- Another merchant's ids answer 404 on every route; outlet routes no longer accept an outlet of another merchant.
- An agent voiding a line already sent to the kitchen gets a proposal. A right PIN no longer lifts a lock. Setting a customer's groups through `customers.upsert` needs a Manager.

### Fixes
- A paired station reads its merchant settings and POS channel link before anyone signs in.
- Every phone at a table sees the order's guest rounds.
- Closing an order ends its guest sessions even when an agent closed it.
- A cash tip stays in the drawer instead of going back as change: expected cash includes cash tips, and the Z-report, shift screens and receipts show them on their own row.
- Reports filtered by staff no longer fail. The POS lists today's closed orders by the business day. A dry run that skips an agent's ceiling always rolls back.
- `events.list` filters by type instead of failing; print health counts a business day's jobs; a business-day cutoff in a daylight-saving gap or overlap ends the day once.
- Front ends: unreadable text caused by a clashing colour token, a duplicate key on the PIN pad, the pay screen polling dry runs, smaller POS and guest defects.

### Tooling and docs
- ESLint for `ui`, `web` and `guest`; a Playwright end-to-end suite (`pnpm test:e2e`) for the back office, POS and guest app.
- Documentation rewritten for an outside reader: architecture, configuration, self-hosting, roadmap, contributing and security guides replace the planning papers and build notes.

## Beta v1 (package version 0.9.0-beta.1, not tagged)

### Hardening review
- Money and state: daily caps and "sold out for today" follow the business-day cutoff everywhere. A paid bill never changes: its lines keep their stored amounts and adjustment shares through every later re-price, and edits aimed at them are refused with `check_locked_by_payment`. Fixed-per-order fees freeze at the first payment. A payment is validated against the bill as re-priced at the first payment. Reopen is refused once the order has a refund (`order_has_refunds`). Voids are valued with their modifiers in the Z-report and the void report.
- Security and robustness: pairing a station again invalidates its previous token. Replayed requests (proposal approval) no longer take a second admission-gate slot, and a queued request gives up with 503 after `QUEUE_WAIT_MS`. Concurrent requests with the same `Idempotency-Key` all receive the stored result. Merchant settings are validated. Validation errors carry their `remedy`.
- Latency: events are appended after pricing and the snapshot, deferred sum triggers fire before the outlet's sequence lock, and writes are batched and reads pipelined. With 20 local writers, the p95 of `lines.add` fell from 593 to 416 ms and of `orders.fire` from 833 to 391 ms.
- API additions: `payment.due_cents`, `tenders_summary` on the Z-report, `refunded_total` on the order snapshot, `round_no` on print jobs, `gate.timed_out` on `/health`.
- Web: POS auto-lock, errors hidden behind sheets, all client-side money arithmetic removed, one idempotency key per logical action, live regions for totals and alerts.

### Reports, agents and MCP
- Reports from SQL views (`report_*`, `security_invoker`): sales summary, product mix by item, category and staff, void, discount and refund exceptions, print health, daily outlet report; CSV everywhere and a PDF daily summary.
- Agent identities with role, scope, toolsets, risk ceiling and budgets; 15-minute sessions with on-behalf-of intersection; the `app_agent` Postgres role; proposals for operations above the ceiling, approved or rejected by staff and replayed as the approver; kill switch and credential rotation.
- MCP adapter (`--role=mcp`): tools generated from the spec, filtered per identity, each call an in-process API request; floor and menu resources; untrusted text wrapped; `mcp-tools.json` checked in CI.

### Scan to Order
- Rotatable table QR tokens and a printable QR sheet; public guest sessions with short-lived tokens, rate-limited per device and table; the read-only `app_guest` role, with guest writes made by the register after validation.
- Guest rounds held for acceptance or sent straight to the kitchen per channel link; table requests with printed slips; call for the bill; sessions end when the order closes.

### Front ends
- Guest app: table landing with brand theming, menu, item sheet, basket, rounds with live status, call staff and ask for the bill, digital receipt page. No payment screen.
- POS: pairing, lock and PIN, floor, orders list, order entry with layouts and modifiers, bills with every split mode, payment panel, refunds with manager approval, shift open and close with a blind count and Z-report, sold out, print alerts, QR rounds and requests, Day and Service themes.
- Back office: catalogue, menus, availability, sold out, CSV import, pricing rules with versions and a simulator, customers, floor editor, printing, orders with refunds and documents, stations, channels, tenders, void reasons, team, audit, Today, Z-report and shifts.

### Splits and refunds
- Split evenly, by seat or by item with equal shares; free until the first payment, then locked per paid bill; per-bill receipts, invoices and cash rounding.
- Refunds in full, by lines and quantities or by amount, with adjustments and tax reversed in proportion, tenders assigned to original payments within caps, Manager+ or a manager approval, and a reason. Numbered refund receipts and credit notes; refunds dated by business day; database invariants on refund sums and caps.

### Payments, shifts and documents
- Bills with allocations rebuilt after every re-price and database-enforced sums. Several tenders and part payments per bill, recorded by hand with references; cash rounding only on the cash tender that settles a bill; tips; pricing freeze at the first payment; same-day reopen.
- Pre-bills and receipts printed through the relay; digital receipts by public token. Gap-free invoice numbers and PDF invoices. Shifts with float and counted cash, business-day close and the Z-report.

### Kitchen printing
- Printers, relays and one-time relay pairing; the `app_relay` role. ESC/POS templates at 80 and 58 mm with CJK raster fallback and golden-file tests. Routing by tags, filters, station printers, copies and a default printer. Durable queue with claim and acknowledge, stale-claim re-queue, late-job alerts, reroute and reprint. The relay service and its multi-arch Dockerfile.

### Orders and the POS register
- Station pairing and tokens, PIN sessions with lockout and idle expiry, single-use manager approvals. One order model for dine-in, takeaway, pickup and delivery; lines with modifier validation, availability, sold out and daily caps; send and hold, voids, cancel, change type, move table, attach customer, manual adjustments; floor snapshot and the outlet stream.

### Catalogue and pricing configuration
- Products with prices per order type, tags and a deposit flag; modifier groups two levels deep; categories; brand menus; availability rules; sold out and daily caps; channel links; areas and tables; tenders; void reasons; POS layouts. Customers and groups; versioned pricing rules with scheduled activation and a simulator. CSV importer with dry-run reports and safe re-runs. Compiled menu per channel link.

### Pricing engine
- The pure pricing function `price(order, rules, context)` with explicit discount levels, exclusive and stackable discounts, caps, inclusive and exclusive tax, freeze at first payment and a step-by-step trace. Largest-remainder allocation, cash rounding and percent helpers. Seed rules: six manual discounts plus the preset's service charge and deposit. Validation warnings. A hand-calculated reference set and property tests.

### Foundations
- pnpm and Turbo monorepo. Hono API with a committed OpenAPI spec and manifest-driven permissions (`x-sail`). Request pipeline: admission gate, one transaction per request, RLS context and `SET LOCAL ROLE`, idempotency keys. Append-only event log with per-outlet sequences, `pg_notify` to SSE with heartbeats, `resync` and catch-up. Merchants, brands, outlets, stations, staff with five fixed roles, audit log. Embedded-Postgres test harness and the RLS replay test. CI with typecheck, tests, spec and migration drift checks.
