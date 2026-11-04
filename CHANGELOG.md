# Changelog

All notable changes to Sail. Phases follow `docs/roadmap.md`; each has a completion note in `docs/completions/`.

## Unreleased (feat/beta-v1)

### v0.8 Scan to Order
- Rotatable table QR tokens and a printable QR sheet (PDF); public guest sessions with short-lived tokens, rate-limited per device and table.
- `app_guest` principal and read-only Postgres role (menu and own order only); guest writes run as the register after validation.
- Guest rounds held for acceptance or fired immediately per channel link; accept/reject at the POS; table requests with printed slips; call for bill marks the table; guest order view without prices or payments; per-order guest stream; sessions revoked when the order closes.
- Invariant triggers made SECURITY DEFINER and re-read rows at commit; events filter by aggregate; availability rule delete; dev:local runs the worker.

### Web: iPad POS (v0.4) and back-office catalogue, pricing, floor, orders screens (v0.3)
- POS at /pos: pairing, lock and PIN, floor with live tables, orders list, order entry with layouts, modifier sheet, order sheet and action dock, manager approval sheet, undo, discounts, event store over SSE with catch-up, Day/Service themes.
- Back office: products, bulk price, modifier groups, menus with drag-and-drop, categories, availability, sold out, legacy CSV import review; pricing rules with versions and simulator; customers; floor editor; orders drawer; stations pairing; channels, tenders, void reasons.

### v0.7 Bill splitting and refunds
- Split evenly by N, by seat (shared lines even or on a Shared bill) and by item with equal shares; free until the first payment, locked per paid bill; per-bill receipts, invoices and cash rounding.
- Refunds: full, by lines and quantities, by amount; adjustments and GST reversed in proportion; tenders assigned to original payments within caps; cash rounding on cash refunds; Manager+ or override; reason required.
- Numbered refund receipts (print or link) and credit notes (PDF) for invoiced bills; refunds dated by business day and included in shift close and the Z-report; daily caps not restored.
- Database invariants: refund sums, per-line and per-payment caps, immutable refund rows.
- `@sail/shared` `quoteRefund` pure reversal with property tests.

### v0.6 Payments, shifts and tax documents
- Checks (bills) with allocations rebuilt after every re-price; database-enforced bill and line sums; bills lock at the first payment and new lines open a new bill.
- Payments: several tenders and part payments per bill, card/PayNow/house tenders by hand with references, cash rounding only on the settling cash tender, tips, idempotent recording, pricing freeze at first payment, auto-completion, same-day reopen with reversed payments.
- Pre-bills and receipts printed through the relay; digital receipts by public token (email/SMS pending a provider).
- Gap-free tax invoice numbering, PDF invoices with UEN (pdf-lib), stored invoice snapshots.
- Shifts with float and counted cash, expected vs counted including rounding, business-day close, basic Z-report.
- `@sail/shared` bill allocation helper (`allocateLine`, even/shared/whole shares) with property tests.

### v0.5 Kitchen printing
- Printers, relays and one-time relay pairing; `app_relay` principal and narrow Postgres role.
- ESC/POS renderer in `@sail/shared`: kitchen, void, reprint, pre-bill, receipt, refund receipt and service-slip templates at 80 mm and 58 mm, CJK raster fallback, golden-file tests.
- Routing by tags, filters, station printers, copies and the default fallback printer; one job per printer per copy in the fire/void transaction.
- Durable print queue with claim/ack, stale-claim re-queue, late-job query, reroute to backup, reprint, test print, relay heartbeats and offline alerts.
- `@sail/relay`: Node relay service (SSE + catch-up, TCP 9100 with DLE EOT status, retries, heartbeat), multi-arch Dockerfile; `docs/runbooks/relay.md`.

### v0.4 Orders and the POS (register)
- Station pairing codes and tokens, PIN sessions with lockout and inactivity expiry, HMAC PIN lookup unique per merchant.
- Single-use manager override grants (`POST /v1/overrides`) bound to one action and target, approver recorded on events and audit.
- One order model for dine-in, takeaway, pickup and delivery with per-type validation, one open order per table, per-outlet order numbers, optimistic concurrency and dry runs.
- Lines with modifier validation, availability, sold-out and atomic daily caps; fire/hold, partial voids, cancel, change type, move table, attach customer, manual adjustments.
- Pricing pipeline run on every change; adjustments and per-line amounts persisted under deferred sum invariants.
- Floor snapshot, order lists, quote with trace, outlet stream in production use.

### v0.3 Catalogue, pricing configuration and legacy import (register)
- Products with per-order-type prices, tags and BCRS; modifier groups nested to two levels; two-level categories; brand menus with sections and items; availability rules; per-outlet 86 and daily caps.
- Channel links with Scan to Order settings; areas and tables; tender types; void reasons; POS layouts with 12 curated colours.
- Customers and customer groups; versioned pricing rules with scheduled activation, simulator on persisted rules, validation warnings.
- CSV legacy importer with dry-run reports, apply and idempotent re-runs; `docs/csv-mapping.md`; products CSV export.
- Compiled menu per channel link for the POS and the guest app.

### v0.2 Pricing engine
- Pure pricing pipeline `price(order, rules, context)` in `@sail/shared` with fixed rule schema, explicit discount levels, exclusive/stackable stacking, caps, both tax modes, freeze-at-first-payment semantics and a step-by-step trace.
- Largest-remainder allocator, cash rounding and percent helpers shared by pricing, splits and refunds.
- Seed configuration: service charge 10% (dine-in, GST-applicable), container deposit per unit on BCRS products, six manual presets including the service-charge waiver.
- Validation warnings: overlapping exclusive rules, products no fee covers, caps below minimum, empty open ranges.
- 91-case hand-calculated reference set with coverage tracking, plus property tests; `docs/pricing-semantics.md`.

### v0.1 Foundations
- pnpm/Turbo monorepo with `shared`, `server`, `web`, `ui`.
- Hono API with `@hono/zod-openapi`, committed `openapi.json`, manifest-driven permissions (`x-sail`), shared error shape with remedies.
- Request pipeline: admission gate, one transaction per request, `set_config('app.current_*')` + `SET LOCAL ROLE`, Idempotency-Key storage and replay, RLS opt-out list under test.
- Append-only event log with per-outlet sequences, `pg_notify` → LISTEN → SSE fan-out with heartbeats and `resync`, catch-up endpoint.
- Organisation model (merchant settings, brands, outlets, stations), staff with five fixed roles and outlet/brand scope, audit log with a single writer.
- Embedded-Postgres test harness (no Docker needed), generic RLS replay test, `dev:local` runner with a bootstrapped merchant.
- CI: typecheck, tests, OpenAPI check, migration drift check, forbidden-term scan; staging and production deploy jobs gated on secrets.
- Back-office shell: login, Today, outlets, brands, stations, merchant settings, team, audit; `ui` package with design tokens for the Day and Service themes.
