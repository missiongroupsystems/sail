# Extensions

An extension is a downstream deployment that adds to Sail without editing it: its own API routes, operations, worker
tasks and tables, its own back-office pages, and its own product name. It keeps Sail as a dependency (a pinned
checkout or package) and builds Sail's server and web app with its additions.

Sail is in beta. The parts below are the ones meant for extensions; anything else, imported by path, can change in any
release.

## Server

A start file calls `startServer` with the extension's modules. Each module registers what it adds when it is imported,
after Sail's own modules and before the app, worker or MCP server is built:

```ts
import { startServer } from "@sail/server";

await startServer({ modules: [() => import("./notes.js")] });
```

`startServer` starts the role named by `--role=app|worker|mcp` (or `SAIL_ROLE`) and returns `{ port, stop }`.
SIGTERM and SIGINT stop it; `stop()` removes those handlers again.

Import everything from `@sail/server` (`packages/server/src/public.ts`), never a Sail file by path:

| Export | Use |
|---|---|
| `startServer`, `registerRoutes`, `defineOp`, `dataResponse`, `listResponse`, `mutationResponse`, `jsonBody`, `jsonResponse`, `errorResponses`, `z` | Routes, as Sail's own (how-to.md, section 1) |
| `registerOperations`, `roleAtLeast` | Manifest entries. A key already registered is refused, and a registered spec is read-only |
| `db`, `tx`, `schema` | In a route handler: the caller's request transaction, under row-level security |
| `AppError`, `appendEvent`, `outletVisible`, `principalCanSeeOutlet`, `principalRole` | Errors, events and the caller's scope in a handler |
| `registerWorkerTask`, `registerPaymentProvider`, `registerOrderClosedHook`, `registerRepriceHook`, `onCancel`, `onFire`, `onVoid` | Worker tasks, a payment provider and order hooks |
| `runMigrations`, `migrationSetsFromEnv` | A migrate file (see Migrations) |
| `bootstrapMerchant`, `createMerchant`, `runImportJob`, `importInto` | A set-up script: a merchant with its first brand, outlet, station and Admin, and the CSV importer |

**These run outside row-level security**, as the connection owner, so every query must name the merchant:
`withTransaction` (worker tasks and start-up steps only, never in a handler), `bootstrapMerchant`, `createMerchant`,
`runImportJob`, `importInto` (in the transaction it is given) and `runMigrations`. Sail has no function for stations or
channel links outside its routes: a set-up script creates those through the API (`POST /v1/stations`,
`POST /v1/channel-links`), not with SQL.

Importing `@sail/server` builds nothing and adds no routes, but the route modules it reaches register their operations,
so an extension's operation keys must not collide with Sail's. Use a prefix of your own (`ext.notes.list`).

`SAIL_DEV_MODULES` (comma-separated paths) loads modules into `pnpm --filter @sail/server dev:local`, after Sail's, the
way `startServer({ modules })` does.

## Web

`SAIL_EXTENSIONS` names a folder, relative to `packages/web` or absolute, with two modules:

- `index`: its default export is an `Extensions` object (`packages/web/src/extensions/types.ts`): rail sections,
  pages with their roles, and the brand. The whole app imports it, so it holds no page components.
- `pages`: its default export maps the same paths to client components. Only the `/x/` page imports it. With no pages,
  export `{}`.

`packages/web/test/extension` is a complete example, built in CI.

- **Pages** are served under `/x/<path>`. Every page names its `minRole` (`"server"` is every staff member); a page
  without one stops the build. Anyone below the role gets Sail's refusal page, naming the role; signed out goes to sign
  in. A rail section whose page is above the person's role is hidden.
- **Brand**: `brand: { name, mark?, icon? }` replaces Sail's name on sign-in, the rail, the POS, lock, pairing and
  kitchen screens and the POS app manifest. `mark` is a component drawn beside the name; without one the name stands
  alone (the collapsed rail shows its initial). `icon` is the URL of the browser-tab, home-screen and POS app icon (an
  absolute URL, or `import icon from "./icon.png"` and `icon: icon.src`); without one the icon is the name's initial,
  never Sail's sail.
- **Tailwind** scans the folder too, so its classes are generated.
- **Webpack only.** The folder is swapped in by a webpack plugin; `next dev --turbopack` and `next build --turbopack`
  refuse `SAIL_EXTENSIONS`.
- **Turbo's cache cannot see the folder** when it lies outside `packages/web`: an edit there reuses the last build.
  Build the web app with `pnpm --filter @sail/web build` (no Turbo cache), or pass `--force` to `turbo run build`.

## Migrations

An extension's tables live in a Postgres schema of its own, with its own Drizzle migrations folder (`meta/_journal.json`
and the `.sql` files). The runner applies Sail's migrations first, then each extension's set in a transaction of its
own, so a failing migration undoes that set's pending migrations and leaves Sail's applied.

- **Run them** with `SAIL_MIGRATIONS=ext_shop=path/to/drizzle` for `pnpm db:migrate`, Sail's `node dist/migrate.js` and
  `dev:local` (comma-separate several sets; `ext_shop.my_table=path` names the tracking table; paths are resolved from
  the working directory), or from code with `runMigrations(url, { sets: [{ folder, schema }] })`.
- **Tracking.** Each set is tracked in `sail_migrations.<schema>` (or the table named), with the same drift check as
  Sail's: the runner refuses a database ahead of the folder, and checks every set before it applies anything.
- **One at a time.** The runner holds a session advisory lock for the whole run, so two deploys cannot race.
- **One database role.** Run every migration, Sail's and every set's, as the same role. Default privileges apply only to
  tables created by the role that set them.
- **Refused:** the schemas `public`, `sail`, `drizzle`, `sail_migrations`, `information_schema`, `pg_*` and those a
  managed Postgres keeps for its services (`auth`, `storage`, `extensions`, `realtime`, `vault`, `graphql`,
  `pgbouncer` and the like), a schema named twice, and Sail's own folder.
- **Forward-only**, like Sail's: never edit an applied migration, and give each new one a journal `when` later than every
  applied one (Drizzle applies by that timestamp).

### The recipe

With drizzle-kit, declare the tables with `pgSchema("ext_shop")` and let `drizzle-kit generate` write the first
migration (it starts with `CREATE SCHEMA "ext_shop"`). Then add a hand-written one (`drizzle-kit generate --custom`)
with the grants and row-level security:

```sql
GRANT USAGE ON SCHEMA ext_shop TO app_authenticated, app_agent;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ext_shop TO app_authenticated, app_agent;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA ext_shop GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_authenticated, app_agent;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA ext_shop GRANT USAGE, SELECT ON SEQUENCES TO app_authenticated, app_agent;
--> statement-breakpoint
ALTER TABLE ext_shop.notes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY notes_tenant ON ext_shop.notes FOR ALL TO app_authenticated, app_agent
  USING (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id))
  WITH CHECK (merchant_id = sail.merchant_id() AND sail.outlet_allowed(outlet_id));
--> statement-breakpoint
CREATE POLICY notes_brand_scope ON ext_shop.notes AS RESTRICTIVE FOR ALL TO app_authenticated, app_agent
  USING (sail.brand_allowed(brand_id))
  WITH CHECK (sail.brand_allowed(brand_id));
```

- **Every table** has `merchant_id`, row-level security and a tenant policy. Add `sail.outlet_allowed(outlet_id)` for
  rows of an outlet, and the restrictive `sail.brand_allowed(brand_id)` policy for rows of a brand, so staff and agents
  limited to some brands see only those (as Sail's migrations 0044 and 0046 do). A row without a brand stays visible.
- **References to Sail's rows are composite**, so a row cannot name another merchant's outlet or brand:
  `FOREIGN KEY (outlet_id, merchant_id) REFERENCES public.outlets (id, merchant_id)`, and the same for `brands` (as
  Sail's migration 0051 does). A key to `merchants(id)` is enough on its own. Do not add keys to other Sail tables: a
  later Sail migration may rewrite or drop them, or Sail may delete their rows. Keep other Sail ids as plain `uuid`.
- **`app_guest` and `app_relay`** reach only what their own policies allow. A grant alone shows them nothing; each needs
  a policy of its own, scoped as Sail scopes them (migration 0014: a guest sees its own order and session, a relay its
  outlet's printers). Never give them the tenant-wide policy above. `app_agent` above gets the tenant policy, as on
  Sail's operational tables; keep customer contact columns away from it.
- **Never touch Sail's tables, functions or tracking tables** in a migration. Change Sail's data through its operations.
- **Test your tables** as `packages/server/test/ext-migrations.test.ts` does for its fixture
  (`test/fixtures/ext-migrations`, generated from `test/fixtures/ext-migrations-src`): two merchants, a brand-limited
  caller, another merchant's outlet, and nothing without a merchant. Sail's RLS replay test checks `public` only.

## A production image

`@sail/server` exports TypeScript source, so a production server bundles the start file with Sail inlined:

```ts
// tsup.config.ts
export default defineConfig({ entry: { server: "src/start.ts", migrate: "src/migrate.ts" }, format: ["esm"], platform: "node", noExternal: ["@sail/server", "@sail/shared"] });
```

Install `@sail/server`'s dependencies in the image (the bundle leaves them external), and copy two migrations folders:
Sail's (`packages/server/drizzle`) and the extension's own. A bundled migrate file names Sail's folder, because a bundle
cannot find it next to the runner (and never takes the extension's `drizzle/` for it):

```ts
import { migrationSetsFromEnv, runMigrations } from "@sail/server";

await runMigrations(process.env.MIGRATE_DATABASE_URL!, { folder: "sail-drizzle", sets: migrationSetsFromEnv() });
```

Run it before starting a new version, as with Sail's own image ([self-hosting.md](self-hosting.md)). The web app is
built with `SAIL_EXTENSIONS` set (webpack) and served with `next start`.

## Not supported yet

- Pages on the POS, the kitchen display or the guest app: extension pages are back-office pages under `/x/`.
- New principal types or roles: an extension works with Sail's five roles and its staff, station, guest, relay and
  agent principals.
- Changing Sail's own screens, operations or tables.
