# Self-hosting

Sail is beta software and has not run in production anywhere yet. Read the README's status section first.

## What runs

| Service | Package | Command | Notes |
|-|-|-|-|
| API | `server` | `node dist/index.js --role=app` | Stateless; run two or more behind HTTPS. Holds one `LISTEN` connection per process for SSE. |
| Worker | `server` | `node dist/index.js --role=worker` | One instance. Scheduled rules, imports, print-claim re-queue, relay alerts, guest and proposal expiry, and the payment-provider outbox, polling and expiry. |
| MCP adapter | `server` | `PORT=8090 node dist/index.js --role=mcp` | Optional; only if you connect agents ([mcp.md](mcp.md)). Serves `/mcp`; give it its own `PORT`, since the default is 8080 like the API. |
| Back office and POS | `web` | `pnpm --filter @sail/web build`, then `pnpm --filter @sail/web start` | Next.js on port 3000. The POS is `/pos`. |
| Guest app | `guest` | `pnpm --filter @sail/guest build`, then `pnpm --filter @sail/guest start` | Next.js on port 3001. Give it its own host name; it is what table QR codes open. |
| Print relay | `relay` | `pnpm --filter @sail/relay build`, then `node packages/relay/dist/index.js` (or the Docker image) | One per outlet, on the outlet network. Outbound HTTPS only. |
| PostgreSQL | | | Tests, CI and `dev:local` use 17.6. Older versions are untested. |

The API, worker and MCP adapter are one build: `pnpm --filter @sail/server build` writes `packages/server/dist`. `packages/server/Dockerfile` and `packages/relay/Dockerfile` build images (run `docker build -f packages/server/Dockerfile .` from the repository root). `examples/fly/fly.toml` is one example of a deployment (Fly.io), with the commands to use it in its comments; nothing in the code depends on a provider, and the project's CI deploys nothing. With `NODE_ENV=production` the API refuses to start if a token secret still has a placeholder value from the repository (`change-me-...` or the `local-...` values `dev:local` uses) or is shorter than 32 characters.

## Environment variables

### API, worker and MCP adapter

Read in `packages/server/src/config.ts`; `packages/server/.env.example` has a template. The worker needs the database and logging variables, plus `STATION_TOKEN_SECRET` with the API's value, because staff CSV imports store PIN lookups. The four device token secrets are optional in the schema, but without them pairing and PIN sign-in fail at the first request, so treat them as required. With the built-in sign-in, the API refuses to start without `SESSION_TOKEN_SECRET`.

| Name | Purpose | Secret |
|-|-|-|
| `NODE_ENV` | Set to `production`. | No |
| `PORT` | Listen port (default 8080). | No |
| `LOG_LEVEL` | pino level (default `info`). | No |
| `DATABASE_URL` | Connection for request transactions. Works through a transaction pooler (`prepare: false`). | Yes |
| `LISTEN_DATABASE_URL` | Direct session connection for `LISTEN` (SSE). Must be on port 5432 unless `ALLOW_POOLER_LISTEN=1`. Defaults to `DATABASE_URL`, which is fine when that is a direct connection. | Yes |
| `ALLOW_POOLER_LISTEN` | `1` skips the port 5432 check, for a direct connection on another port. | No |
| `DB_POOL_MAX` | Pool size per process (default 10). | No |
| `TX_MAX`, `QUEUE_MAX`, `QUEUE_WAIT_MS` | Admission gate: concurrent request transactions (6), queued requests (64) and how long one waits (10000 ms) before a 503. | No |
| `CORS_ORIGIN` | Comma-separated origins allowed to call the API. Default `*`. | No |
| `SESSION_TOKEN_SECRET` | Signs back-office sessions from the built-in sign-in. At least 16 characters. | Yes |
| `TRUST_PROXY` | `1` takes the sign-in lockout's client address from the last `X-Forwarded-For` entry ([Sign-in](#signing-in-and-lockout)). | No |
| `SUPABASE_URL` | Switches back-office sign-in to an external issuer ([below](#an-external-identity-provider)): JWTs are verified against `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`. Another issuer serving JWKS at that path also verifies, but the web app's `/login` only supports Supabase email and password, so it would need its own login front end. | No |
| `SUPABASE_JWT_SECRET` | Alternative: verify the external issuer's JWTs with this HS256 secret. Also switches to the external issuer. | Yes |
| `STATION_TOKEN_SECRET` | Signs station and PIN-session tokens, and keys the PIN lookup hash. At least 16 characters. | Yes |
| `GUEST_TOKEN_SECRET`, `RELAY_TOKEN_SECRET`, `AGENT_TOKEN_SECRET` | Sign guest, relay and agent tokens. At least 16 characters each. | Yes |
| `PIN_SESSION_IDLE_SECONDS` | A PIN session ends after this much inactivity (default 900). | No |
| `GUEST_APP_URL` | Base URL of the guest app, used in table QR codes and digital receipt links (`/r/<token>`). | No |
| `WEB_APP_URL` | Declared but not read by any code today. | No |
| `SAIL_VERSION` | Reported by `/health` and the spec. The Dockerfile sets it from a build argument. | No |
| `SAIL_ROLE` | Alternative to `--role`. | No |
| `PAYMENT_SIMULATOR_URL` | Development and tests: the terminal simulator behind the `simulator` payment provider. Leave unset in production. | No |
| `MIGRATE_DATABASE_URL` | Used by `db:migrate` and `bootstrap`: a direct session connection. | Yes |

### Web (back office and POS)

`packages/web/.env.example`. `NEXT_PUBLIC_*` values are read at build time, so set them before `build`.

| Name | Purpose | Secret |
|-|-|-|
| `NEXT_PUBLIC_API_URL` | The API. The back office proxies `/api/v1/*` to it with the session cookie; the POS calls it directly from the iPad. | No |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Only for an API with an external issuer: `/login` signs in with Supabase email and password and sends the access token to the API. With the built-in sign-in they are not used. | No (the anon key is public) |

### Guest app

`packages/guest/.env.example`.

| Name | Purpose | Secret |
|-|-|-|
| `NEXT_PUBLIC_API_URL` | The API, called from the guest's phone with a short-lived guest token. | No |

### Print relay

| Name | Purpose | Secret |
|-|-|-|
| `SAIL_API_URL` | The API. Required. | No |
| `SAIL_RELAY_PAIRING_CODE` | The 6-digit code from the back office, for the first start only. | Yes, until used |
| `SAIL_RELAY_STATE_FILE` | Where the relay keeps its token (default `/data/relay.json`, which exists only in the image; set it elsewhere). Keep it on persistent storage. | Holds a secret |
| `SAIL_RELAY_VERSION` | Reported in heartbeats. | No |

## Database and migrations

The connection user owns the schema: the migration `0001_rls_foundations.sql` creates the four `NOLOGIN` roles (`app_authenticated`, `app_guest`, `app_relay`, `app_agent`) and grants them to that user, so it must be allowed to create roles. Use the same user for migrations and the API.

```bash
MIGRATE_DATABASE_URL=postgres://user:password@host:5432/sail pnpm db:migrate
```

It checks how many migrations are applied, migrates, and checks again; it refuses to run if the database is ahead of the code. Migrations only move forward. In a built image, `node dist/migrate.js` does the same. Run migrations before starting a new API version, and keep each release's migrations compatible with the version still running (add columns and tables; drop them a release later).

## Sign-in

The back office signs people in through exactly one identity provider, chosen by the API's environment. `GET /v1/auth/status` says which one is active and whether setup is still needed.

| Provider | Selected when | Who checks the password |
|-|-|-|
| `local` (built in) | Neither `SUPABASE_URL` nor `SUPABASE_JWT_SECRET` is set (the default) | Sail: email and password, hashed with scrypt; needs `SESSION_TOKEN_SECRET` |
| `oidc` | Either is set | Your external issuer; Sail verifies its JWTs (JWKS or HS256) |

Station pairing, POS PINs, guest sessions and agent credentials do not depend on it.

### First run

Open the back office. While the database has no merchant, every page leads to **Set up Sail**: business name, region preset ([configuration.md](configuration.md#region-presets)), time zone, the first outlet's name, and your name, email and password (at least 12 characters). Setup creates the merchant from the preset with one brand, one outlet, one POS station and you as its Admin, then signs you in. It works once: after the first merchant exists it is refused, including when two people submit it at the same moment. With the `oidc` provider the form asks for no password; your email is pre-authorised and you sign in through your identity provider with it.

Until setup has run, anyone who can reach the back office can run it, so finish it before you open the back office to the internet.

### Headless installs

`bootstrap` does the same from a source checkout (it is not in the Docker image). Run it with the API's own `DATABASE_URL` and `STATION_TOKEN_SECRET`, because the Admin's PIN is stored with a lookup hash keyed by that secret:

```bash
DATABASE_URL=postgres://user:password@host:5432/sail \
STATION_TOKEN_SECRET=<the API's value> \
SAIL_ADMIN_PASSWORD='at least 12 characters' \
pnpm --filter @sail/server bootstrap "Example Bistro" "Sam Admin" admin@example.com 246810 \
  --preset=us --time-zone=America/Chicago
```

Arguments: merchant name, Admin name, Admin email, an optional 6-digit PIN, then `--preset=sg|us|eu-vat|jp|blank` and `--time-zone=<IANA zone>`, both required. `--currency` and `--locale` override the preset and are required with `blank`. It prints the ids it created. The password comes from the environment so it stays out of the shell history; leave `SAIL_ADMIN_PASSWORD` unset with the `oidc` provider and the email is pre-authorised instead. The script does not check the PIN or the secret: a PIN that is not exactly 6 digits, or a missing or different `STATION_TOKEN_SECRET`, stores a PIN that never signs in.

### Signing in and lockout

Sessions last 12 hours. **Sign out** in the user menu ends the session on the server as well as in the browser; **Change password** in the same menu ends your other sessions. An unknown email and a wrong password get the same answer. The lockout is built so that knowing someone's email does not let you lock them out, while guessing stays slow:

| Counter | Limit | Effect |
|-|-|-|
| One address and one email | 5 failures | That pair is locked for 15 minutes, the right password included. The owner signing in from their own address is not affected. |
| One address, any emails | 20 failures | The address is locked for 15 minutes (password spraying). |
| One email, all addresses together | after 5 failures | Each further failure pauses that email for 2, 4, 8 ... seconds, up to 3 minutes, which keeps guesses from many addresses near 20 an hour. During an attack the owner waits at most 3 minutes, not 15. |
| One email, all addresses together | 50 failures | The email is locked for 15 minutes, and an `auth.sign_in_locked` entry in the merchant's audit log tells the Admins. |

A right password clears the email's and the pair's counts but never a lock or a pause, and never the address's count. The counters are in Postgres, so they hold across API machines and restarts. Changing your password has its own limit: 5 wrong current passwords lock password changes for that person for 15 minutes.

The address counters use the address the API sees. `X-Forwarded-For` is honoured only when `TRUST_PROXY=1`; without it the header is ignored, so a caller cannot choose its own address (a test covers both). When the API is reached only through the web app or a proxy that sets `X-Forwarded-For`, set `TRUST_PROXY=1` so it counts the browser's address (the last entry) instead of the proxy's. Do not set it when callers can reach the API directly, because they could then choose their own address. The web app passes on the header it receives, so put a proxy in front of it that overwrites `X-Forwarded-For` with the real client address. Without one, a caller can send a different address on every attempt and avoid the address lock; the email lock still applies. Without `TRUST_PROXY`, every sign-in through the web app shares the web server's address, so twenty failures from anyone lock web sign-in for everyone for 15 minutes.

### Adding people

Admins manage access in **Team**: open a staff member and use **Back-office access**. It works from a back-office session only, never from an Admin's PIN on the POS. The person needs an email on their staff record; an existing POS PIN is kept.

- **Invite to the back office** gives a link, shown once, that works for 7 days and only once. Send it to the person yourself; they choose a password and are signed in. Generating a new link cancels the old one.
- **Password reset link** works the same way for someone who already has a password, valid for 24 hours. Using it ends all their earlier sessions. Sail sends no email.
- Deactivating a staff member also ends their sessions and open links; reactivating does not bring them back.
- **Revoke access** removes the login, ends every session and cancels open links. The staff record and PIN stay, and they can be invited again. You cannot revoke your own access.

One email signs in to one staff record on the whole server, so an invite is refused if another merchant's staff member already signs in with that email.

### An external identity provider

Set `SUPABASE_URL` or `SUPABASE_JWT_SECRET` on the API, and `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` on the web app. **Invite** then pre-authorises the staff member's email instead of giving a link. On their first sign-in through the identity provider with that email, Sail links the account to the staff record. Emails nobody pre-authorised are refused; Sail never creates staff from a sign-in. Only a token whose top-level `email_verified` claim is `true` is linked; a token without the claim, or with it set to anything else, is refused. Supabase Auth does not put that claim at the top level of its access tokens (it copies it into `user_metadata`, which users can edit themselves, so Sail never reads it there). On Supabase, add it with a [custom access token hook](https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook) that sets `email_verified` to `email_confirmed_at is not null` from `auth.users`. Once linked, later sign-ins match on the subject and need no claim.

## Devices

**Stations.** In Settings > Stations, open a station and press Pair an iPad; enter the code (valid 10 minutes) on the iPad at `/pos`. The POS calls `NEXT_PUBLIC_API_URL` directly from the iPad, so the API address must be reachable from the iPad, and the web app's origin must be in `CORS_ORIGIN`. Staff then sign in with their PIN. Pairing again invalidates the previous token.

**Kitchen displays.** A station of kind Kitchen display pairs the same way, with the code entered at `/kds` on the screen. It needs no PIN and no back-office sign-in, and shows only the tickets of its display destinations ([configuration.md](configuration.md#kitchen-display)). `/pos` refuses a kitchen display's code and `/kds` a POS station's, before the code is used.

**Print relays.** One per outlet, paired with a code from Printing > Relays. Install, printers, replacement and troubleshooting: [runbooks/relay.md](runbooks/relay.md).

## Security settings to change

1. Run the web app with `NODE_ENV=production` (`next start` sets it), so its session cookie is marked secure.
2. Generate each token secret separately (for example `openssl rand -base64 48`) and keep them out of the repository. Rotating a secret signs out every device of that kind. Rotating `STATION_TOKEN_SECRET` also breaks every stored PIN lookup, so every staff PIN has to be set again.
3. Set `CORS_ORIGIN` to your web and guest app origins; the default allows any origin.
4. Decide on back-office sign-in ([Sign-in](#sign-in)). With the built-in one, set `SESSION_TOKEN_SECRET` and put a proxy that overwrites `X-Forwarded-For` in front of the web app before you set `TRUST_PROXY=1`. The built-in sign-in has no multi-factor step, so if staff with the Admin or Finance role need one, use an external identity provider and turn it on there.
5. Terminate TLS in front of the API, web and guest apps.
6. Rotate the table QR tokens (Floor & QR, or `tables.rotate_qr_token`) when you print the sheets you will use.
7. Rate-limit the public endpoints (pairing, guest and agent session start, receipts) at your proxy. The API limits back-office sign-in, guest sessions, rounds and table requests itself, but not the rest.
8. Turn on backups and point-in-time recovery for the database.
9. If you connect agents, give each identity the narrowest toolsets and a T0 or T1 ceiling.

## Operating

- **Card payments recorded by hand** need checking: compare each card tender's total on the Z-report with the terminal's end-of-day total before closing the shift. A payment taken but not recorded: record it with the terminal reference. Recorded but declined, or the wrong tender: void it (`payments.void`, a Manager) while the shift is open, then record the right tender; after the shift closes, refund it by amount with a reason. Anything left over goes in the shift's variance reason. Tenders linked to a provider are recorded by the register from the provider's answer; a void of one is given back at the provider before the payment is reversed.
- **Releases.** Run migrations before the new API starts. Because migrations only add, the previous API image still runs against the newer schema, so rolling back the API is a redeploy of the old image. Never edit an applied migration; write a new one that reverses it. Deploy the web apps after the API whose spec they were generated from. Restoring a database backup rewinds sales, so treat it as a last resort.

There is no offline mode: if the API is unreachable, stations stop. Agree a paper fallback with each outlet, and alert on `/health`, 503 responses, late print jobs (`GET /v1/outlets/{id}/print-jobs?late=true`) and relays shown offline.
