# A private demo on Fly.io, Supabase and Vercel

A worked example of running Sail as a demo for a small team: the API, the worker and the card-terminal simulator in one Fly.io machine, Postgres on an empty Supabase project, and the back office (with the POS and kitchen display) and the guest app on Vercel behind Vercel's deployment protection. Two demo merchants are seeded: a US diner (sales tax added to prices, tips) and an EU café (VAT included in prices, two rates).

It is not a production layout: one machine runs everything, the terminal is simulated, and there is no printer. For production, read [self-hosting](../../docs/self-hosting.md) and [examples/fly](../fly/fly.toml).

Files here:

| File | What |
|-|-|
| `Dockerfile` | `packages/server/Dockerfile` with a different start command: `start.sh` |
| `start.sh` | Starts the simulator (loopback only), the worker and the API; if one exits, the machine restarts |
| `fly.toml` | One `shared-cpu-1x` machine with 1 GB that never stops, a `/health` check, and migrations as the release command |
| `supabase-setup.sql` | Keeps Supabase's Data API roles off Sail's tables |

The seed is `packages/server/scripts/demo-seed.ts` (`pnpm --filter @sail/server demo:seed`), built on the `dev:local` seed's writers.

## What runs where

| Piece | Where | Port | Notes |
|-|-|-|-|
| API | Fly machine, `node dist/index.js --role=app` | 8080 (Fly serves it on 443) | Holds one `LISTEN` connection for the live streams |
| Worker | Same machine, `--role=worker` | none | Sends payments to the terminal, polls and expires them, and the other scheduled jobs |
| Card-terminal simulator | Same machine, `node dist/payment-simulator.js` | 127.0.0.1:4010 only | Approves each payment after about 1.5 s and posts a signed webhook to the API on 127.0.0.1:8080 |
| Migrations | Fly release command, `node dist/migrate.js` | | Before the new machine starts; the first time, from your laptop (step 4) |
| Postgres | Supabase project | 6543 (transaction pooler), 5432 (direct) | |
| Back office, POS (`/pos`), kitchen display (`/kds`) | Vercel project, root `packages/web` | 443 | The back office calls the API through its own `/api/v1` route; the POS and kitchen display call the API directly from the browser |
| Guest app | Vercel project, root `packages/guest` | 443 | Calls the API directly from the phone |

### Which connection each process uses

| Variable | Used by | Connection | Why |
|-|-|-|-|
| `DATABASE_URL` | API and worker requests; the seed | Transaction pooler, port 6543, user `postgres.<ref>` | Each request is one transaction with `SET LOCAL ROLE` and `set_config(..., true)` only, and `prepare: false`, so a transaction pooler is safe |
| `LISTEN_DATABASE_URL` | The API's one `LISTEN` connection | Direct, `db.<ref>.supabase.co:5432`, user `postgres` | `LISTEN` needs the same server session for as long as it runs; a transaction pooler hands the session to someone else. The direct host is IPv6 only, which Fly machines have. Port 5432 passes the API's start-up check |
| `MIGRATE_DATABASE_URL` | The release command | Direct, as above | One long transaction as the owner |
| (laptop) | Setup SQL, first migration, seed | Transaction pooler, port 6543 | Some networks block 5432. All three were checked through a PgBouncer in transaction mode |

The worker's `pg_notify` calls are made in ordinary transactions and work through any pooler. Only listening needs a session.

### How Sail's database roles work on Supabase

Sail connects as one login, Supabase's `postgres`, which owns the schema. The four application roles (`app_authenticated`, `app_guest`, `app_relay`, `app_agent`) are `NOLOGIN`: nobody signs in as them, so the pooler never sees them. Inside each request's transaction the API runs `SET LOCAL ROLE app_...`, and row-level security applies from then until the commit. `SET LOCAL` ends with the transaction, so the pooled connection goes back clean.

What the migrations need from `postgres`, which is not a superuser on Supabase:

| Migrations use | Needs | Supabase's `postgres` |
|-|-|-|
| `CREATE ROLE ... NOLOGIN` for the four roles, then `GRANT` them to itself | `CREATEROLE`; since Postgres 16 the creator holds `ADMIN OPTION` on roles it creates | Has `CREATEROLE` |
| `SECURITY DEFINER` trigger functions (money invariants, ticket and print-job guards) | Owning the tables they read; they run as their owner | Owns them; also has `BYPASSRLS` |
| `security_invoker` report views | Nothing: they run as the caller, so row-level security applies | |
| Row-level security on all 78 tables, triggers, `pg_advisory_xact_lock` | Table ownership; transaction-scoped locks only (no session locks) | |
| Extensions | None (`gen_random_uuid()` is built in) | |

So the migrations run unchanged. `supabase-setup.sql` is hardening, not a requirement: Supabase's default privileges would grant `anon`, `authenticated` and `service_role` every right on each new table in `public`. Row-level security gives the first two no rows anyway (every policy names an `app_` role), but `service_role` bypasses it, and the table names would show in the Data API's schema. The file revokes those defaults before the first migration, and the grants on anything already there.

### First run on a deployed instance

While the database has no merchant, the back office shows **Set up Sail**, and anyone who reaches the API can submit it once. This demo never shows it: the seed creates both merchants from your laptop before the API is deployed (steps 4 and 5), so the API is never on the internet with an empty database. The seed is the headless route, like `bootstrap` in [self-hosting](../../docs/self-hosting.md#headless-installs), with a menu and staff on top.

## Environment variables

Generate every token secret with `openssl rand -hex 32`. The API refuses to start in production with one shorter than 32 characters or with a value published in the repository.

### API, worker and simulator (Fly)

| Name | Purpose | Secret | Value here |
|-|-|-|-|
| `NODE_ENV` | `production`: secrets and `WEB_APP_URL` become required | No | `fly.toml` |
| `PORT` | API port | No | `8080`, `fly.toml` |
| `LOG_LEVEL` | pino level | No | `info`, `fly.toml` |
| `PAYMENT_SIMULATOR_URL` | Where the `simulator` payment provider sends payments | No | `http://127.0.0.1:4010`, `fly.toml`; `start.sh` uses that port |
| `DATABASE_URL` | Request transactions | Yes | Transaction pooler, see above |
| `LISTEN_DATABASE_URL` | The `LISTEN` session | Yes | Direct connection |
| `MIGRATE_DATABASE_URL` | Release command | Yes | Direct connection |
| `SESSION_TOKEN_SECRET` | Signs back-office sessions | Yes | Keychain |
| `STATION_TOKEN_SECRET` | Signs station and PIN tokens and keys PIN lookups; the seed must use the same value | Yes | Keychain |
| `GUEST_TOKEN_SECRET` | Signs guest tokens and derives table QR codes | Yes | Keychain |
| `RELAY_TOKEN_SECRET`, `AGENT_TOKEN_SECRET` | Print relays and agents (unused here, set anyway) | Yes | Keychain |
| `WEB_APP_URL` | The back office's address, for invite and reset links | No | The web project's production address |
| `GUEST_APP_URL` | Base of table QR links and digital receipts | No | The guest project's production address |
| `CORS_ORIGIN` | Origins allowed to call the API from a browser | No | Both addresses, comma-separated |
| `TRUST_PROXY` | Take the sign-in lockout's address from `X-Forwarded-For` | No | Unset. Fly's proxy adds the caller's address as the last entry, and for back-office sign-ins the caller is the web app's server, so the setting would change nothing. Every sign-in through the web app shares one lockout address: 20 wrong passwords from anyone lock back-office sign-in for 15 minutes |
| `DB_POOL_MAX`, `TX_MAX`, `QUEUE_MAX`, `QUEUE_WAIT_MS`, `PIN_SESSION_IDLE_SECONDS` | Pool and admission gate, PIN timeout | No | Defaults |
| `SUPABASE_URL`, `SUPABASE_JWT_SECRET` | External sign-in | | Unset: the demo uses Sail's own email and password sign-in |

### Seed (from your laptop)

| Name | Purpose | Secret |
|-|-|-|
| `DATABASE_URL` | Transaction pooler, as the API's | Yes |
| `STATION_TOKEN_SECRET` | The API's value, or no PIN signs in | Yes |

### Web and guest (Vercel)

| Name | Project | Purpose | Secret |
|-|-|-|-|
| `NEXT_PUBLIC_API_URL` | both | The API, `https://<app>.fly.dev`. Inlined at build time, so set it before the first deploy | No |
| `ENABLE_EXPERIMENTAL_COREPACK` | both | `1`: Vercel installs with the `pnpm` version in the root `package.json` | No |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | web | External sign-in only | Unset |

Project settings, set by the commands below: framework Next.js, root directory `packages/web` or `packages/guest` with files outside it included, install command `pnpm install --frozen-lockfile --filter @sail/web...` (or `@sail/guest...`), so only that app's workspace packages install, default build command (`next build`), Node 22, functions in the region next to the API, and Vercel Authentication on all deployments.

## Rough monthly cost

| Item | Cost |
|-|-|
| Fly: one `shared-cpu-1x` 1 GB machine that never stops, shared IPv4, `fly.dev` certificate | About US$6 to 8, depending on the region |
| Supabase: an existing project | Nothing extra; a project on a paid organisation already pays for its compute (Micro is about US$10, usually covered by the plan's credit). A free-plan project pauses after a week unused |
| Vercel: two projects in an existing Pro team | Nothing extra within the plan's included usage |
| Total | About US$6 to 8 a month of new spend |

## The deploy, in order

Run on a Mac with `psql`, Node 22, pnpm 10 (Corepack), the Fly CLI (`fly auth login`) and the Vercel CLI (`vercel login`). Every secret goes from the Keychain to the command that needs it; none is typed, printed (except the two demo Admin passwords, once) or written to a file.

### 1. Names, a clean clone and helpers

Set the names for your demo. None of them is a secret.

```sh
APP=<fly app name>                    # its API is https://$APP.fly.dev
FLY_ORG=<fly organisation slug>
REGION=<fly region>                   # next to the database
VERCEL_SCOPE=<vercel team slug>
VERCEL_REGION=<vercel function region next to $REGION>
WEB_PROJECT=<vercel project for the back office>
GUEST_PROJECT=<vercel project for the guest app>
REF=<supabase project ref>
POOLER=<the project's pooler host>    # Supabase: Connect → Transaction pooler
KC=<prefix for this demo's Keychain entries>
API=https://$APP.fly.dev
```

Deploy from a fresh clone, so nothing built or installed locally is uploaded:

```sh
git clone --branch <branch> https://github.com/<owner>/sail.git ~/sail-demo && cd ~/sail-demo
corepack enable && pnpm install --frozen-lockfile
```

Helpers for this shell (they read the Keychain each time and store nothing):

```sh
pw()  { security find-generic-password -s "$KC-$1" -w; }
enc() { node -e 'process.stdout.write(encodeURIComponent(require("fs").readFileSync(0, "utf8").trim()))'; }
pooled() { printf 'postgresql://postgres.%s:%s@%s:6543/postgres?sslmode=require' "$REF" "$(pw db | enc)" "$POOLER"; }
direct() { printf 'postgresql://postgres:%s@db.%s.supabase.co:5432/postgres?sslmode=require' "$(pw db | enc)" "$REF"; }
```

### 2. Secrets into the Keychain

The database password: in the Supabase dashboard, **Project Settings → Database → Reset database password → Generate a password → Copy**, then

```sh
security add-generic-password -U -s "$KC-db" -a postgres -w "$(pbpaste)"; pbcopy </dev/null
```

The five token secrets. Without `-U`, `add-generic-password` refuses to overwrite an entry that exists; keep an existing one, because a new `station-secret` locks out every seeded PIN.

```sh
for s in session station guest relay agent; do security add-generic-password -s "$KC-$s-secret" -a sail -w "$(openssl rand -hex 32)"; done
```

Check the password and the role through the transaction pooler (expect `t|t|f`: can create roles, bypasses row-level security, not a superuser):

```sh
PGPASSWORD="$(pw db)" psql "host=$POOLER port=6543 user=postgres.$REF dbname=postgres sslmode=require" -tAc \
  "SELECT rolcreaterole, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user"
```

### 3. Database setup

```sh
PGPASSWORD="$(pw db)" psql "host=$POOLER port=6543 user=postgres.$REF dbname=postgres sslmode=require" \
  -v ON_ERROR_STOP=1 -f examples/preview/supabase-setup.sql
```

Expect `DO`, three `ALTER DEFAULT PRIVILEGES` and three `REVOKE`. Sail does not use Supabase's Data API, so you can also switch it off: **Project Settings → Data API**.

### 4. Migrate

```sh
MIGRATE_DATABASE_URL="$(pooled)" pnpm --filter @sail/server db:migrate
```

Expect `drift check: 0 of 51 migrations applied`, then `51 of 51` (the count grows with later releases). Later deploys migrate in the release command.

### 5. Seed the two demo merchants

```sh
DATABASE_URL="$(pooled)" STATION_TOKEN_SECRET="$(pw station-secret)" pnpm --filter @sail/server demo:seed
```

It prints, for each merchant, the outlet, the POS station and kitchen display ids, the Admin's email with a generated password, and the staff PINs. The passwords are shown this once. Store each in the Keychain now; `-w` as the last option asks for the password, so it is pasted at a prompt rather than written in the command:

```sh
security add-generic-password -s "$KC-us-admin" -a admin.us@example.com -w
security add-generic-password -s "$KC-eu-admin" -a admin.eu@example.com -w
```

Run again, the seed changes nothing and says `already there, left as it was`. To start the demo data over, empty the database (Tear down) and run steps 3 to 5 again.

### 6. Vercel projects

The team's id, for the deploys:

```sh
VERCEL_ORG_ID=$(vercel api /v2/teams --raw | node -e 'const t=JSON.parse(require("fs").readFileSync(0,"utf8")).teams.find((t)=>t.slug===process.argv[1]); process.stdout.write(t?t.id:"")' "$VERCEL_SCOPE"); echo "$VERCEL_ORG_ID"
```

Create both projects with their settings and the API's address. The first deploy goes to production, so the variables are set for production as well as previews.

```sh
project() { # name, package
  node -e 'const [name, pkg, api, region] = process.argv.slice(1); const env = (key, value) => ({ key, value, type: "plain", target: ["production", "preview"] });
    process.stdout.write(JSON.stringify({ name, framework: "nextjs", rootDirectory: `packages/${pkg}`, installCommand: `pnpm install --frozen-lockfile --filter @sail/${pkg}...`, serverlessFunctionRegion: region, ssoProtection: { deploymentType: "all" },
      environmentVariables: [env("NEXT_PUBLIC_API_URL", api), env("ENABLE_EXPERIMENTAL_COREPACK", "1")] }))' "$1" "$2" "$API" "$VERCEL_REGION" \
  | vercel api /v11/projects --scope "$VERCEL_SCOPE" -X POST --input - --raw | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).id ?? "")'
}
WEB_ID=$(project "$WEB_PROJECT" web); GUEST_ID=$(project "$GUEST_PROJECT" guest); echo "$WEB_ID $GUEST_ID"
for id in "$WEB_ID" "$GUEST_ID"; do
  printf '{"nodeVersion":"22.x","sourceFilesOutsideRootDirectory":true}' | vercel api "/v9/projects/$id" --scope "$VERCEL_SCOPE" -X PATCH --input - --silent
done
```

`ssoProtection: all` is Vercel Authentication on every deployment, production included: only signed-in members of the team can open either app. Check it in **Project → Settings → Deployment Protection**.

Deploy both from the clone's root (the whole workspace uploads; Vercel builds in the root directory):

```sh
VERCEL_ORG_ID=$VERCEL_ORG_ID VERCEL_PROJECT_ID=$WEB_ID vercel deploy --prod --yes
VERCEL_ORG_ID=$VERCEL_ORG_ID VERCEL_PROJECT_ID=$GUEST_ID vercel deploy --prod --yes
```

Each production deployment gets a stable address, `https://<project>-<team slug>.vercel.app`. Read both:

```sh
alias_of() { vercel api "/v9/projects/$1" --scope "$VERCEL_SCOPE" --raw | node -e 'const a=JSON.parse(require("fs").readFileSync(0,"utf8")).targets?.production?.alias??[]; process.stdout.write(a.find((d)=>d.endsWith(`-${process.argv[1]}.vercel.app`))??a[0]??"")' "$VERCEL_SCOPE"; }
WEB=https://$(alias_of "$WEB_ID"); GUEST=https://$(alias_of "$GUEST_ID"); echo "$WEB $GUEST"
```

Use only these two addresses: the API accepts browser calls from them alone (`CORS_ORIGIN`), so a POS opened on a per-deployment URL cannot reach it.

### 7. Fly app, secrets and deploy

```sh
fly apps create "$APP" --org "$FLY_ORG"
{
  printf 'DATABASE_URL=%s\n' "$(pooled)"
  printf 'LISTEN_DATABASE_URL=%s\n' "$(direct)"
  printf 'MIGRATE_DATABASE_URL=%s\n' "$(direct)"
  for s in session station guest relay agent; do printf '%s_TOKEN_SECRET=%s\n' "$(echo "$s" | tr a-z A-Z)" "$(pw "$s-secret")"; done
  printf 'WEB_APP_URL=%s\nGUEST_APP_URL=%s\nCORS_ORIGIN=%s,%s\n' "$WEB" "$GUEST" "$WEB" "$GUEST"
} | fly secrets import --app "$APP" --stage
fly secrets list --app "$APP"    # names and digests only
fly deploy --app "$APP" --config examples/preview/fly.toml --dockerfile examples/preview/Dockerfile \
  --primary-region "$REGION" --ha=false --remote-only --build-arg SAIL_VERSION="$(git rev-parse --short HEAD)" .
```

The release command logs `migrated: 0 applied`. If `fly ips list --app "$APP"` shows no addresses afterwards, run `fly ips allocate-v4 --shared --app "$APP"` and `fly ips allocate-v6 --app "$APP"`.

If the API exits with a connection error to `db.<ref>.supabase.co`, the machine cannot reach the IPv6 host; use the session pooler (port 5432 on the pooler host, which holds one server session per client, so `LISTEN` works there too) and deploy again:

```sh
session() { printf 'postgresql://postgres.%s:%s@%s:5432/postgres?sslmode=require' "$REF" "$(pw db | enc)" "$POOLER"; }
printf 'LISTEN_DATABASE_URL=%s\nMIGRATE_DATABASE_URL=%s\n' "$(session)" "$(session)" | fly secrets import --app "$APP"
```

### 8. Check

```sh
curl -s "$API/health"                       # {"ok":true,"db":"ok","version":"<commit>",...}
fly logs --app "$APP" --no-tail | tail -20  # "Terminal simulator on http://127.0.0.1:4010", "worker started", "LISTEN sail_events established", "sail api listening"
```

Then walk through [How a tester gets in](#how-a-tester-gets-in) once yourself: a terminal payment that turns to Paid on its own shows the simulator, the webhook, the worker and the live stream all work.

## How a tester gets in

Everything is behind Vercel Authentication: sign in to Vercel as a member of the team on each device first (laptop, iPad, phone).

| | Where | Who |
|-|-|-|
| Back office | `$WEB` | US diner: `admin.us@example.com`; EU café: `admin.eu@example.com`. Passwords from the Keychain entries `$KC-us-admin` and `$KC-eu-admin`; share them one to one, not in a channel |
| POS | `$WEB/pos` on an iPad, or a browser window about 1180 by 820 | A pairing code from the back office, then a PIN |
| Kitchen display | `$WEB/kds` on a screen or another window | A pairing code, no PIN |
| Guest | A table's link on a phone, `$GUEST/t/<code>` | Nothing else |

Pair a POS: in the back office, **Settings → Stations**, open **Station 1** (or 2 or 3), press **Pair an iPad**. On the iPad open `$WEB/pos`, type the six digits, then a PIN. Each merchant has three POS stations; pairing a station again signs out the device paired before, so testers take one each. One browser profile holds one station: use separate windows of different profiles, or a private window, to run a POS and a kitchen display side by side.

Pair a kitchen display: the same, with **Kitchen display 1** (or 2) and **Pair a screen**, then `$WEB/kds`.

Staff PINs, the same at both merchants:

| Person | Role | PIN | Can |
|-|-|-|-|
| Alex Admin (US), Robin Admin (EU) | Admin | 123456 | Everything |
| Morgan Manager | Manager | 222222 | Voids, refunds, discounts, approving for others |
| Casey Cashier | Cashier | 333333 | Orders, payments, shifts |
| Sam Server | Server | 444444 | Orders and sending; no payments |
| Frankie Finance | Finance | 555555 | Reports and the Z-report |

A guest link: in the back office, **Floor & QR**, pick an area and a table, press **Rotate code** and open the link it shows on a phone. The first scan opens the table's order, and staff accept each round on the POS.

## Try this

**Cashier at the POS (333333)**

1. **Shift → Open shift**, count a float with **Count notes and coins**. Cash needs an open shift; cards do not.
2. **Floor**, tap a free table, choose the guests, add a burger: the sheet asks how it is cooked and offers add-ons. Add a drink, press **Send**.
3. **Pay**, choose **Card (terminal)**, pick a tip (US diner), press **Send to the terminal**: it turns to Paid after a moment, with the tip on the receipt.
4. At the café, pay in cash with **Cash given**: the POS shows the change. Then **QR on screen** for the digital receipt, with both VAT rates after the total.
5. **Shift → Close shift**, count the drawer; a count that is off asks for a reason. **Z-report** shows the day.

**Manager (222222)**

1. On a sent order, tap a line and void it with a reason.
2. **Orders → Today's closed**, open a paid order, **Refund** some items; a cashier gets the **Manager approval** sheet, where you type your PIN.

**Server (444444)**

1. Take and send orders. A server cannot take a payment: that needs a cashier or above.
2. Accept a guest's QR round from the **Now** rail on the floor.

**Kitchen display (no PIN)**

1. Tickets arrive as the POS sends them, with modifiers and the all-day count. Bump one when it is ready; **Recall** brings it back. A voided line shows struck through.

**Guest (phone)**

1. Open a table's link, order a burger well done and a drink, review and send. The page follows the round from sent to accepted.
2. **Call staff**: the request shows on the POS.

**Admin (back office)**

1. **Menu**: mark an item sold out and watch it grey out on the POS and the guest menu.
2. **Pricing → Simulator**: price a basket against the rules.
3. **Reports**: sales, items and the Z-report after a shift closes.
4. **Team**: open a staff member and make an invite link (Sail sends no email; the link is shown once).

Not in this demo: printing (no relay or printer, so "receipt did not print" notices are expected), a real card terminal, paying on the guest's phone, and agents.

The simulator approves every payment. To make the next one on the terminal decline, from your laptop:

```sh
fly ssh console --app "$APP" -C "node -e \"fetch('http://127.0.0.1:4010/terminals/sim-1/next',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({outcome:'decline'})}).then((r)=>r.text()).then(console.log)\""
```

## Tear down

```sh
fly apps destroy "$APP" --yes
vercel api "/v9/projects/$WEB_PROJECT" --scope "$VERCEL_SCOPE" -X DELETE --dangerously-skip-permissions
vercel api "/v9/projects/$GUEST_PROJECT" --scope "$VERCEL_SCOPE" -X DELETE --dangerously-skip-permissions
```

Deleting the Supabase project is permanent; ask its owner first. To empty it and keep the project, through the transaction pooler:

```sh
PGPASSWORD="$(pw db)" psql "host=$POOLER port=6543 user=postgres.$REF dbname=postgres sslmode=require" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL client_min_messages = warning;
DROP SCHEMA IF EXISTS drizzle CASCADE;
DROP SCHEMA IF EXISTS sail CASCADE;
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
DROP ROLE IF EXISTS app_authenticated, app_guest, app_relay, app_agent;
COMMIT;
SQL
```

Then the Keychain entries:

```sh
for s in db session-secret station-secret guest-secret relay-secret agent-secret us-admin eu-admin; do security delete-generic-password -s "$KC-$s" >/dev/null; done
```
