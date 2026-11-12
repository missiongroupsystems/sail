# Contributing

Thanks for helping. Issues and pull requests are welcome. By contributing you agree that your work is licensed under the [Apache License 2.0](LICENSE).

## Setup

Node 22.12 or newer, with Corepack (it provides pnpm 10.17.1).

```bash
corepack enable && pnpm install
pnpm --filter @sail/server dev:local   # API on :8080 with an embedded Postgres and demo data
pnpm --filter @sail/web dev            # back office and POS on :3000 (admin@sail.local, password sail-demo-password)
pnpm --filter @sail/guest dev          # guest app on :3001
```

The tests start their own embedded PostgreSQL, so you need no database or Docker. Read [docs/architecture.md](docs/architecture.md) before a large change.

## Checks

Run these before you open a pull request. CI (`.github/workflows/ci.yml`) runs the typecheck, lint, the shared, server and relay tests, the spec, tool-list and migration checks, a forbidden-term scan (`pnpm check:no-other-pos`, which skips itself unless `SAIL_FORBIDDEN_TERMS_FILE` is set) and the server and web builds, and the end-to-end suite as a separate job.

| Check | Command |
|-|-|
| Types | `pnpm typecheck` |
| Lint (`ui`, `web`, `guest`) | `pnpm lint` |
| Unit, property, reference-set and database tests | `pnpm test` |
| OpenAPI spec is up to date | `pnpm openapi:check` |
| MCP tool list is up to date | `pnpm --filter @sail/server manifest:check` |
| Schema changes have a migration | `pnpm db:generate` (must say "No schema changes" unless you meant to add one) |
| End-to-end, in a browser | `pnpm test:e2e` (starts the API, web and guest apps itself, plus a second API and back office on an empty database for first-run setup; needs ports 8080, 3000, 3001, 8091 and 3002 free, or `E2E_API_URL` and `E2E_SETUP_API_URL` to move the APIs; run `pnpm --filter @sail/e2e exec playwright install chromium` once) |

With `dev:local` running, `pnpm --filter @sail/guest smoke` and then `pnpm --filter @sail/web pos:smoke` drive the guest and POS flows through the API. Run them in that order on a fresh `dev:local`: the POS smoke uses up a guest rate limit the guest smoke needs.

## Conventions

The recipes are in [docs/how-to.md](docs/how-to.md). The rules that matter most:

- **The register owns money and state.** Totals, tax, allocations and rounding come only from `price()` and the allocators in `@sail/shared`. Clients format amounts; they never add them up. Money is an integer in minor units; percentages are basis points.
- **Every operation starts in the manifest.** Add it to `packages/shared/src/manifest.ts` with its tier, role, principals, events and MCP exposure, define the route with `defineOp`, then regenerate the spec and tool list (`pnpm --filter @sail/server openapi:generate` and `manifest:generate`) and commit both. Never check roles by hand in a handler.
- **Free text from people is untrusted.** Wrap notes, reasons, names and addresses in `untrusted(...)` so agents receive them as `{ untrusted_text }`.
- **Every tenant table has `merchant_id`** and row-level security in a hand-written migration. `rls-replay.test.ts` fails otherwise. Enforce money invariants in the database as well as in code.
- **Business date, never calendar date**, for anything daily: caps, sold out for today, reports, refunds.
- **No country in the logic.** Tax, currency, locale and time come from merchant settings. Country-specific values belong in a preset in `packages/shared/src/presets.ts`.
- **Tests encode intent.** A new behaviour gets a test that fails if the behaviour breaks. A change to pricing, splits or refunds grows the reference set in `packages/shared/src/pricing/reference` with a hand-worked case. Changes to the pricing engine, the allocators, RLS policies, database invariants or the manifest need a second reviewer.
- **Migrations move forward only** and stay compatible with the previous release of the API.

## Commits and pull requests

Commit messages follow the repository's existing style: `type(scope): what changed, in plain words`, for example `fix(server): count each PIN attempt before checking it`. Types in use: `feat`, `fix`, `test`, `docs`, `chore`. Explain why in the body when it is not obvious. Keep pull requests to one change, and say how you tested it.

Write code comments, docs and UI copy in British English, in plain words and short sentences.
