# Changelog

All notable changes to Sail. Phases follow `docs/roadmap.md`; each has a completion note in `docs/completions/`.

## Unreleased (feat/beta-v1)

### Beta v1 review: correctness, security, latency and UI hardening
Full record in `docs/completions/beta-v1-review.md`.
- **Money and state.** Daily caps and "sold out for today" now follow the outlet's business-day cutoff everywhere (the stock list and compiled menu used the calendar date, so caps appeared to reset at midnight). A paid bill never changes: lines on a paid bill keep their stored amounts and adjustment shares through every later re-price (new lines, customers attached, scheduled rules, caps), and edits aimed at them are refused with `check_locked_by_payment`. Fixed-per-order fees freeze at the first payment (reference case R153; set now 153). A payment is validated against the bill as re-priced at the first payment, never a stale balance. Reopen is refused once the order has a refund (`order_has_refunds`). Voids are valued with their modifiers in the Z-report and the void report. `checks.allocate` with `add_checks` keeps the new empty bill.
- **Security and robustness.** Re-pairing a station invalidates the previous station token (the resolver did not compare hashes). In-process replayed requests (proposal approval) no longer take a second admission-gate slot, and a queued request gives up with 503 after `QUEUE_WAIT_MS`. Concurrent requests with the same `Idempotency-Key` all receive the stored result (the replay path aborted the transaction). Merchant settings validate the time zone, cutoff, GST rate and rounding increment. `orders.quote` no longer takes the order's row lock. Validation errors carry their `remedy` at the top level.
- **Latency.** Events are appended after pricing and the snapshot, `settleInvariants()` fires the deferred sum triggers before the outlet's sequence lock is taken, event append is one statement, re-price and allocation writes are batched, and independent reads are pipelined. Local 20-writer p95 for mutations fell from 593 to 833 ms to 391 to 416 ms (single-process harness; see the note).
- **API additions (compatible).** `payment.due_cents` on `payments.record`; `tenders_summary` on the Z-report; `refunded_total` on the order snapshot; `round_no` on print jobs; `gate.timed_out` on `/health`; `counted_counts`/`float_counts` must add up to their totals.
- **Web.** POS auto-lock fixed (never fired); register errors raised from inside sheets were hidden behind the scrim; all client-side money arithmetic removed (payment panel, bill footer, refund sheets, Z-report card total); one idempotency key per logical action for new orders and refunds; search results carry tile access levels; reroute has Undo; totals and alerts have live regions; dead code removed. Guest app and relay: see the completion note.

### v0.9 Reporting, hardening and beta readiness
- Reports from SQL views (`report_*`, security_invoker): sales summary with every §4.10 filter, product mix by item/category/staff, void/discount/refund exceptions, print health (late counts, p50/p95 fire-to-printed), daily outlet report combining the Z-report with breakdowns; CSV everywhere and a PDF daily summary.
- Agent principal (vision §7): agent identities with role, scope, toolsets, risk ceiling and budgets; 15-minute task-bound sessions with on-behalf-of intersection; `app_agent` Postgres role with no access to secrets or configuration writes; proposals for operations above the ceiling, approved or rejected by staff and replayed exactly as the approver; kill switch and credential rotation.
- MCP adapter (`--role=mcp`): tools generated from the OpenAPI x-sail manifest, filtered per identity, every call an in-process API request; floor and menu resources; untrusted text wrapped; committed `mcp-tools.json` checked in CI.
- Reference set grown to 152 pricing cases plus 24 hand-worked split and refund cases.
- Hardening documents: release and rollback policy, runbooks (card-terminal mismatch, mid-service outage), token-scope security review, MCP guide; parallel-run reconciliation script; local load-test script. RLS replay covers `app_agent` and `app_guest`.
- Session last-seen updates skip locked rows so nested register requests cannot deadlock.

### v0.8 Scan to Order
- Rotatable table QR tokens and a printable QR sheet (PDF); public guest sessions with short-lived tokens, rate-limited per device and table.
- `app_guest` principal and read-only Postgres role (menu and own order only); guest writes run as the register after validation.
- Guest rounds held for acceptance or fired immediately per channel link; accept/reject at the POS; table requests with printed slips; call for bill marks the table; guest order view without prices or payments; per-order guest stream; sessions revoked when the order closes.
- Invariant triggers made SECURITY DEFINER and re-read rows at commit; events filter by aggregate; availability rule delete; dev:local runs the worker.

### Web: guest app (v0.8), POS bills, payments, refunds, shift and print alerts (v0.6 to v0.9), back-office printing, orders actions, Today and reports (v0.9)
- Guest app `packages/guest`: table landing with brand theming, menu, item sheet, basket and review, send to kitchen with idempotent retry, round status with live updates, call staff and ask for the bill, digital receipt page; never a payment screen.
- POS: bill screen with every split mode, payment panel with cash dry run, refund stepper with manager approval, shift open and close with blind count and Z-report, sold out and printers, print failure banner, Now rail with QR rounds, requests and pickups.
- Back office: Printing (printers, relays with pairing, print jobs with preview, reprint and reroute), orders drawer actions (refund stepper, reopen, receipts, invoices, credit notes, reprints), Floor QR sheets and rotation, Today as the service list, Z-report and shifts pages.

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
