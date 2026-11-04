# Changelog

All notable changes to Sail. Phases follow `docs/roadmap.md`; each has a completion note in `docs/completions/`.

## Unreleased (feat/beta-v1)

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
