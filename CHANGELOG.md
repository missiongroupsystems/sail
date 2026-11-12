# Changelog

Notable changes to Sail, newest first. Field and operation names are as in `packages/server/openapi.json`.

## Unreleased

### Money
- A frozen order discount takes at most what a line is now worth: after a payment, cutting or comping a line on an unpaid bill can no longer take it, its tax or its bill below zero.
- Money fields read back everything they show, in every locale: Arabic-Indic and other native digits are accepted, as are Latin digits; groups must be the locale's. One parser (`parseAmount`) for every field. See [pricing semantics §8](docs/pricing-semantics.md#8-tax-model).
- A paid bill's receipt, tax invoice and refund receipt no longer change when the order is re-priced: adjustments keep their ids, and a split bill's adjustment rows add up to its discount and fee.
- Amounts are bigint (migrations 0047 to 0049). Every amount a request carries, and every line and order subtotal, is at most `MAX_AMOUNT` (10^12 minor units), with a validation error above it; IDR and VND days close.
- Cash needs an open shift (`no_open_shift`). A payment or refund taken in a shift counts on the shift's business day. A business day closes once, only with its shifts closed and orders settled; after an early close new activity is dated on the next day. `orders.reopen` refuses a payment whose shift or day is closed, as `payments.void` does. See [§10](docs/pricing-semantics.md#10-business-days-shifts-and-the-z-report-server-not-the-engine).
- The Z-report adds `reversals` (voided and reopened payments), `reconciliation` (tenders against sales) and `refunds.taxes`; the sales summary adds `refunds.taxes`; the exceptions report adds `payment_reversals`.
- Refunds: the last units of a line give back exactly what is left; a tender split naming a payment twice is checked once against it; cash goes back rounded on the payment's running total, never more than it took.
- PDFs print the euro sign, the yen sign and amounts in Arabic locales (Latin digits, the ISO code where a symbol cannot be drawn).
- The importer refuses a row whose price or price override is not an amount instead of importing it without its override.
- A terminal void the provider made although every call to it failed is found by the poll and applied; if the bill was refunded, the order cancelled or the shift or day closed in the meantime, the payment stands and `payment_intent.voided_not_applied` says why.
- `pricing.simulate` refuses lines above `MAX_AMOUNT` with a validation error, and the POS amount pad takes amounts up to it.
- Approving an agent's proposal re-quotes its money effect: if a pricing rule, tax rate or customer group has moved the order's figures since the proposal (the order's version unchanged), it fails with `version_conflict` and both sets of figures instead of running at amounts nobody saw.
- A shift-close, business-day-close or stock-cap proposal whose figures have not moved can be approved again: the stored figures were compared as text in jsonb's key order, so every such proposal failed.
- A manager override's amounts (`overrides.grant`) are bounded by `MAX_AMOUNT` like every other request amount.
- Thermal receipts print amounts from the printer's code page in Latin digits: the euro sign as WPC1252's 0x80, a symbol the code page lacks (₹, ฿, د.ك.) as the ISO code, as on the PDFs.
- `dev:local` and the test harness stop their embedded Postgres and remove its directories when the process is killed or its parent goes away.

### Usability review
- **Upgrade note:** the API refuses to start in production without `WEB_APP_URL` (every role, as the Dockerfile sets `NODE_ENV=production`). Invite and password-reset links point at it; it used to default to `http://localhost:3000`. In development it may be unset, and a link opens the back office it was made from.
- Tips on the POS pay screen, for cash and card: no tip, 15, 18 or 20 percent, or an amount. A new merchant setting `tips_enabled` (on for the `us` preset, off elsewhere and for existing merchants). **Upgrade note:** the register refuses a tip while it is off, on `payments.record` and `payments.start` alike, so a merchant that already takes tips turns it on in Settings. `payments.record` takes `tip_bps` on a dry run, which returns the `tip_cents` to record (a cash tip is rounded to the cash step); `payment.due_cents` now includes the tip, and payment intents return `due_cents`. Migration 0050 `tips_enabled`.
- The QR sheet (`tables.qr_sheet`) prints the codes on the tables and no longer rotates them; codes are derived from their row and `GUEST_TOKEN_SECRET`, so a sheet can be printed again. A code it cannot reprint (made before this version) is refused with the tables named. Rotating every code at an outlet is a separate Admin operation, `tables.rotate_all_qr_tokens`, behind a confirmation in Floor & QR.
- Even splits hand each odd cent to the bill furthest under its share across all the lines, so the bills differ by a cent at most.
- POS lines, bills, pay and refund screens show each line's menu price; discounts, fees and tax are the rows below. The order dock and the floor plan fit an iPad in both orientations, the percentage keypad reads as typed, the connection status follows the network and an item added offline is sent on reconnect, a pending terminal payment is found again on the pay screen, and closing the business day asks first and lists the orders still open.
- The back office's Today shows a setup checklist until the first order is possible, including opening a first shift, because cash is refused until one is open; a duplicate PIN is refused with a message that says so.
- The QR sheet stays a POST whose PDF is a secret, as the agent-safety work made it: it holds every table's code.
- Thermal receipts, PDF invoices and credit notes and the digital receipt show the same payment rows: cash rounding, tip and change.

### Payment providers
- A payment-provider interface (`PaymentProvider`): start a payment on a terminal, read it, cancel it, void it, and verify and parse a webhook. A tender with `provider` and `terminal_id` sends its payments to that terminal; every other tender is recorded by hand as before, and a provider tender can no longer be recorded by hand.
- Payment intents. `payments.start` pins the bill and the amount and tip, writes the intent and an outbox row, and returns at once; the worker calls the provider; the outcome, by webhook or by the worker's poll, is recorded through the ordinary payment path exactly once. An approval for a bill that changed or was paid another way, for a different amount, or after the intent was cancelled or expired (120 s) is voided at the provider and never applied. New operations `payments.start`, `payments.cancel` and `payment_intents.list`, and `payment_intent.*` events.
- An outbox with per-row retries and backoff: a failing provider call never holds up the others, and gives up after 8 attempts.
- Webhooks at `/v1/webhooks/payments/{provider}/{merchant_id}`, verified with the merchant's secret (`payment_providers.configure`), refused when stale, applied once per event id and rate-limited per merchant (verified and refused deliveries counted apart).
- `payments.void` (T3, Manager+ or a manager's approval bound to the payment): reverses a payment recorded in error while its shift is open, its business day is not closed and nothing has been refunded from the bill. A terminal payment is voided at the provider first. An agent's void is a proposal. While a void waits for the provider, refunds on the order and the shift and business-day closes wait too; an order paid on a terminal cannot be reopened.
- A terminal simulator (`pnpm --filter @sail/server sim:payments`, started by `dev:local`) with approve, decline, timeout, duplicate and late outcomes, and a "Card (terminal)" demo tender. The POS pay screen sends a payment to the terminal, waits for the answer on the event stream, and voids a recorded payment.

### Kitchen display
- A kitchen display at `/kds`: a station of the new kind `display`, paired with a one-time code and used without a PIN. It shows the open tickets of its destinations oldest first, with elapsed time in amber and red after `kitchen_warn_minutes` and `kitchen_late_minutes` (merchant settings, defaults 8 and 15), struck voided lines, a changed marker, tap to bump, Recall and an all-day count, live over the outlet stream.
- Display destinations (`display_destinations.*`, on Printing > Printers) route like kitchen printers; stations take `kind` and `display_destination_ids`. A fire creates one ticket per destination in the same transaction as the print jobs. A later fire makes a new ticket, a void after sending strikes the line and flags the ticket changed, and an order cancel cancels its tickets.
- New operations `kitchen_tickets.list`, `kitchen_tickets.all_day` (staff, displays, agents) and `kitchen_tickets.start`, `kitchen_tickets.bump`, `kitchen_tickets.recall` (displays and staff; not for agents, not on MCP). A double bump or two displays on one ticket change it once.
- The POS shows a sent line as ready once the kitchen has bumped every ticket carrying it. `dev:local` seeds one kitchen display per demo merchant.
- `stations.pair` takes an optional `kind`; the display sends `display`, so a POS station's code is refused before it is used and that iPad stays paired.
- Merchants without a display destination print exactly as before and create no tickets.

### Back-office sign-in and first-run setup
- Back-office sign-in goes through one identity provider: `local` (email and password, the default) or `oidc` (an external issuer's JWTs, selected by `SUPABASE_URL` or `SUPABASE_JWT_SECRET`). The local provider needs `SESSION_TOKEN_SECRET`.
- Local sign-in: scrypt password hashes, 12 characters minimum and no composition rules; 12-hour sessions ended by sign-out, a password change, a reset or revocation; the same answer for an unknown email and a wrong password; 5 failures lock an address and email pair and 20 lock an address for 15 minutes, an email pauses after 5 failures from anywhere and locks after 50 (with an audit entry for its Admins), counted in Postgres (`TRUST_PROXY` makes the address the last `X-Forwarded-For` entry).
- First-run setup: with no merchant, the back office opens on setup (`setup.create`, refused once a merchant exists and when two setups race). `bootstrap` takes `SAIL_ADMIN_PASSWORD`; without it the Admin's email is pre-authorised for the external provider.
- Team access: Admins invite staff (single-use link, 7 days), generate reset links (24 hours) and revoke access from the staff sheet. With `oidc`, inviting pre-authorises the email and the first sign-in links the account, so linking a login no longer needs SQL; unknown emails are refused.
- The new operations are hidden from MCP, list no agent principal and cannot become proposals (`proposable: false`; a caller above its risk ceiling is refused). The new tables `backoffice_logins`, `backoffice_sessions` and `backoffice_links` have RLS and no grants for the agent, guest or relay roles, and request roles cannot read password hashes.
- Removed: the email-only development sign-in (`POST /v1/auth/dev-token`) and `DEV_AUTH_SECRET`. `dev:local` seeds the demo Admins with the password `sail-demo-password`. See [self-hosting](docs/self-hosting.md#sign-in).

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
- Issuing a station or relay pairing code, creating or rotating an agent credential and setting a payment provider's webhook secret cannot become proposals (`proposable: false`): a caller above its risk ceiling is refused, so a stored proposal never holds a secret.
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
