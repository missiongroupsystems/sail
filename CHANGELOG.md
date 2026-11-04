# Changelog

All notable changes to Sail. Phases follow `docs/roadmap.md`; each has a completion note in `docs/completions/`.

## Unreleased (feat/beta-v1)

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
