# Sail

Sail is an open-source point of sale for restaurants: an iPad POS, a back office, kitchen printing and QR ordering at the table. One API, the register, does all money math and state changes, and people, devices and AI agents all press the same buttons through it.

It is for restaurant groups and developers who want a POS they can run, read and change themselves, from one outlet to several brands and outlets under one merchant. It is beta software: see [Status](#status).

## What works today

- **POS** (`/pos`, iPad in landscape): pair a station, sign in with a PIN, floor plan with live tables, dine-in, takeaway, pickup and delivery orders, modifiers, seats, hold and send, voids, discounts with manager approval, bills split evenly, by seat or by item, several payment methods per bill, cash rounding, card payments sent to a terminal through a payment-provider interface (a simulator ships; no real provider yet), voiding a payment taken in error, refunds, receipts and invoices, shift open and close with a counted drawer, Z-report.
- **Kitchen printing** through a small relay at each outlet: ESC/POS over the network, routed by product tags and stations, a durable queue with alerts, reprint and reroute.
- **Kitchen display** (`/kds`, a paired screen with no PIN): tickets routed like the printers, struck voids, bump, recall and an all-day count, with ready shown on the POS.
- **Back office** (web): email and password sign-in with first-run setup and invitation links (or your own identity provider), menu, modifiers, availability and sold out, pricing rules with a simulator, tax classes, floor plans and QR sheets, printers and relays, staff and roles, orders with refunds and documents, sales, item, print-health and Z reports, CSV import.
- **Guest QR ordering**: guests scan the table's code, browse the menu, send rounds to the table's order (held for staff to accept, or sent straight to the kitchen), call staff and ask for the bill. Guests never pay on their phones.
- **Agents over MCP**: every operation carries a risk tier (T0 to T3). Agents get scoped identities and short sessions; risky actions become proposals that a person approves, and the register runs exactly what was approved.
- **Any country by configuration**: tax classes and rates, currency, locale, time zone and cash handling are merchant settings, with presets for Singapore, the US, the EU and Japan, and a blank one.

## Quick start

Needs Node 22.12 or newer and Corepack. No Docker or database install: `dev:local` starts an embedded PostgreSQL.

```bash
corepack enable && pnpm install
pnpm --filter @sail/server dev:local   # API on :8080 with an embedded Postgres and two demo merchants
pnpm --filter @sail/web dev            # back office and POS on :3000 (second terminal)
pnpm --filter @sail/guest dev          # guest app on :3001 (optional, third terminal)
```

Open http://localhost:3000 and sign in with `admin@sail.local` (a Singapore demo merchant, GST and SGD) or `admin.eu@sail.local` (a café on the generic EU VAT preset: inclusive VAT at 20% and 10%, EUR). Both use the password `sail-demo-password` and the PIN `123456`.

On a database with no merchant yet, the back office opens on first-run setup instead: your business, a region preset, the first outlet and your Admin login. [Self-hosting](docs/self-hosting.md#sign-in) covers setup, inviting staff and the external identity provider option.

To use the POS, go to Settings > Stations, open Station 1 and press Pair an iPad. Open http://localhost:3000/pos (best in a window about 1180 by 820), enter the code, then the PIN. For guest ordering, seat a table on the POS (guests can only order on an open table), then in the back office open Floor & QR, select that table, press Rotate code and open the link it shows.

`dev:local` also starts a card-terminal simulator: pay with Card (terminal) on the POS and it approves after a moment ([configuration.md](docs/configuration.md#payment-providers) shows how to make it decline).

To try the POS on a real iPad, start the web app with `NEXT_PUBLIC_API_URL` set to an address the iPad can reach (your machine's LAN address and port 8080); the POS calls the API directly.

Each `dev:local` run starts with a fresh database. If port 8080 is taken, run `PORT=8081 pnpm --filter @sail/server dev:local` and start the apps with `NEXT_PUBLIC_API_URL=http://localhost:8081`. Stop everything with Ctrl-C.

To run the checks, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Packages

| Package | What |
|-|-|
| `packages/shared` | Pricing engine, splits and refunds, money and time helpers, region presets, roles and the operation manifest, ESC/POS renderer. Pure TypeScript, no I/O. |
| `packages/server` | The register: Hono API (`/v1`), Drizzle schema and migrations, worker, SSE, MCP adapter. One build, run as `--role=app`, `worker` or `mcp`. |
| `packages/web` | Next.js back office and the iPad POS. |
| `packages/ui` | Components and design tokens shared by the three apps. |
| `packages/guest` | Next.js guest ordering app for phones. |
| `packages/relay` | Print relay for network ESC/POS printers. |
| `packages/e2e` | Playwright tests against the whole stack. |

## Configuration by country

Nothing in the code assumes a country. A merchant is created from a region preset (`sg`, `us`, `eu-vat`, `jp` or `blank`) that sets its currency, locale, tax classes and rates, inclusive or exclusive prices, tax rounding, tenders, cash denominations and registration labels; the time zone is always given explicitly. Every value stays editable, and a preset is plain data you can add to. See [docs/configuration.md](docs/configuration.md).

## Documentation

- [Architecture](docs/architecture.md): how the register, tenancy, auth, printing and agents work.
- [Configuration](docs/configuration.md): merchant settings, presets, tax, cash and time.
- [Self-hosting](docs/self-hosting.md): services, environment variables, migrations, the first merchant.
- [Pricing semantics](docs/pricing-semantics.md): every rule the pricing engine follows.
- [MCP](docs/mcp.md): connecting an agent.
- [How-to](docs/how-to.md): adding operations, tables, migrations and payment providers.
- [CSV import](docs/csv-mapping.md) and the [roadmap](docs/roadmap.md).

## Status

Beta (`0.9.0-beta.1`). Sail has never run a real service in production. The register has unit, property, reference-set and database tests, and an end-to-end suite drives the three apps in a browser, but nothing has been tested on real printers, real card terminals or a busy floor.

There is no private address for security reports yet: [SECURITY.md](SECURITY.md) has a placeholder the maintainers will fill in before the repository is announced. Until then, do not post vulnerabilities in public issues.

Missing today: an adapter for a real card-terminal provider (the interface and a simulator exist; by-hand card payments still work), online payments, offline mode, reviewed configuration changes, a self-serve sign-up and any bundled agents. See the [roadmap](docs/roadmap.md).

## Licence

Apache License 2.0. See [LICENSE](LICENSE). Contributions are welcome under the same licence: see [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues as described in [SECURITY.md](SECURITY.md).
