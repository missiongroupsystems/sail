# How to add a route, a table and a migration

The three recipes every change follows, so the codebase keeps one pattern. Commands and checks are in [CONTRIBUTING.md](../CONTRIBUTING.md); the design behind them is in [architecture.md](architecture.md).

## 1. Add an operation (route)

1. **Add the operation to the manifest** in `packages/shared/src/manifest.ts` (or a module in `packages/server/src/modules` that calls `registerOperations`). Give it an `op` of the form `group.verb`, a risk tier, the minimum role (use `fromPermission("...")` when it comes from the fixed matrix in `roles.ts`), the principal kinds that may call it, the events it emits, and whether MCP exposes it. Write the description for a model as well as a person: when to use it and what it never does.
2. **Define the route** in `packages/server/src/routes/<domain>.ts` with `defineOp(app, { op, method, path, request, responses }, handler)`. `defineOp` sets the `operationId` and `x-sail` extension from the manifest and wraps the handler with the principal and role checks, so **never check roles by hand in a handler**. Path parameters use `{id}` in the path and `z.uuid()` in `request.params`. Wrap any free-text field a guest, customer or person at the register types (notes, reasons, names, addresses) in `untrusted(...)` from `lib/openapi.ts`, so agents receive it as `{ untrusted_text }`.
3. **Shape the response** with the shared envelopes in `lib/openapi.ts`: `dataResponse` for one resource, `listResponse` for lists (`data`, `next_cursor`), `mutationResponse` for mutations (`data`, `events`, `warnings`). Errors are thrown as `AppError` (`lib/errors.ts`) and come out as `{ code, message, remedy, details }`.
4. **Inside a mutation:** use `db()` (Drizzle) or `tx()` (raw postgres.js) from `db/client.ts`; both are bound to the request transaction. Append an event with `appendEvent(...)` (per-outlet sequence, `pg_notify` on commit) and write the audit entry with `recordAudit(...)`. Pass `correlationId` and `idempotencyKey` from the context. For raw queries, pass timestamps as ISO strings and JSON as `JSON.stringify(x)::jsonb` (Drizzle installs transparent serializers on the shared client).
5. **Register** the routes function in `app.ts` (or in a module imported from `modules.ts`), then run `pnpm --filter @sail/server openapi:generate` and `pnpm --filter @sail/server manifest:generate`, and commit `openapi.json` and `mcp-tools.json`. The contract test fails on any route without a manifest entry. Run `pnpm --filter @sail/web gen:api` and `pnpm --filter @sail/guest gen:api` if a front end uses the operation.
6. **Test** in `packages/server/test/<domain>.test.ts` using `freshDb()`, `seedMerchant()` and `api(app).call(...)` from `test/helpers.ts`: happy path, a permission denial for the role below `min_role`, tenancy (a second merchant cannot see the row), and an idempotent replay for mutations.

## 2. Add a table

1. Define it in `packages/server/src/db/schema/<domain>.ts` with Drizzle. **Every table carries `merchant_id`**, and `outlet_id` where an outlet applies. Money is an `integer` in minor units of the merchant's currency. Export it from `schema/index.ts`.
2. Run `pnpm --filter @sail/server db:generate --name=<what>`. Review the SQL.
3. Add RLS in a **hand-written** migration (next section): enable row-level security and add a policy for each role that may touch it, using `sail.merchant_id()` and `sail.outlet_allowed(outlet_id)`. Grants for `app_authenticated` come from default privileges; `app_guest`, `app_relay` and `app_agent` need explicit, narrow grants.
4. Run the server tests. `test/rls-replay.test.ts` discovers every table with a `merchant_id` column and fails if RLS is off, no policy exists, or merchant A can see merchant B's rows. Seed a row for both merchants in that test's `beforeAll` when the table needs rows to prove scoping.
5. If the table has an invariant (sums that must match, caps that must hold), enforce it in the database too: a `CHECK`, a trigger raising `P0001` (surfaced as `invariant_violation`), or a unique index.

## 3. Add a migration

- Generated migrations (`db:generate`) hold only what Drizzle can express: tables, columns, indexes, foreign keys, enums.
- Hand-written migrations (`db:generate:custom`) hold roles, grants, RLS policies, helper functions, triggers, invariants and seeds. Separate `--> statement-breakpoint` lines between statements.
- Migrations are forward-only. Never run `drizzle-kit push` against a shared database.
- `db:migrate` does: drift check (applied count vs journal) → migrate → drift check. CI also runs `drizzle-kit generate` and fails if the schema has drifted from the migrations.
- The test harness builds `sail_template` from the journal on every run, so a broken migration fails every server test.

## 4. Conventions worth knowing

- **Order of work inside a mutation:** lock the row → validate → write the money tables (`repriceOrder`, `syncAllocations`, payments, refunds) → `bumpVersion` → `loadSnapshot` → `settleInvariants()` → append events → respond. Events go last because the first `appendEvent` of a transaction locks the outlet's sequence counter until commit, and every other writer at the outlet waits on it; `settleInvariants()` fires the deferred sum triggers before that lock. Writing a money table after `settleInvariants()` throws (`assertNotSettled`), so the order is enforced, not just documented.
- **Business date, never calendar date:** daily caps, "sold out for today", Z-reports, refund dating and reopen all use `businessToday()`/`businessDayInputs()` from `services/business-day.ts`, which take the merchant's (or outlet's) cutoff and time zone. Availability time windows are the only wall-clock concept (in the merchant's time zone).
- **Independent reads are issued together** with `Promise.all`; postgres.js pipelines them on the transaction's connection, which halves the round trips of a snapshot or a compiled menu.
- **Principals** (`auth/principal.ts`): staff (back-office session from the identity provider in `auth/identity.ts`, or PIN session), station, guest, relay, agent. Each maps to a Postgres role via `SET LOCAL ROLE`; outlet scope is `'*'` or a comma list in `app.current_outlets`.
- **RLS opt-outs** are listed in `db/rls-opt-out.ts` (health, the spec, sign-in status, sign-in, link acceptance, first-run setup, pairing, session starts and receipts) and covered by a test. Stream routes run their access check in a short transaction, then stream outside it.
- **Idempotency** is per principal and key; the first request stores the response, replays return it with `Idempotent-Replayed: true`, a different body gives `idempotency_conflict`.
- **Pricing** is only ever computed by `price()` in `@sail/shared`. Clients format the amounts the register returns; they never add them up.
