# Signing in to the back office

How people get into the back office on a self-hosted Sail, from the first run onwards. Station pairing, POS PINs, guest sessions and agent credentials are separate and unchanged.

## Two identity providers

The API uses exactly one, chosen by its environment:

| Provider | Selected when | Who checks the password |
|-|-|-|
| `local` | Neither `SUPABASE_URL` nor `SUPABASE_JWT_SECRET` is set (the default) | Sail: email and password, hashed with scrypt |
| `oidc` | Either is set | Your external issuer; Sail verifies its JWTs (JWKS or HS256) |

The local provider needs `SESSION_TOKEN_SECRET` (at least 16 characters); the API refuses to start without it. `GET /v1/auth/status` says which provider is active and whether setup is still needed.

## First run

Open the back office. While the database has no merchant, every page leads to **Set up Sail**: business name, region preset (Singapore, United States, EU VAT, Japan or blank), time zone, the first outlet's name, and your name, email and password (at least 12 characters). Setup creates the merchant from the preset, a brand, the outlet, one station and you as its Admin, then signs you in. It works once: after the first merchant exists, setup is refused, including when two people submit it at the same moment.

With the `oidc` provider the form asks for no password. Your email is pre-authorised, and you sign in through your identity provider with it.

### Headless installs

The CLI does the same without a browser:

```bash
MIGRATE_DATABASE_URL=postgres://...:5432/... SAIL_ADMIN_PASSWORD='at least 12 characters' \
  pnpm --filter @sail/server bootstrap "Business name" "Admin Name" admin@example.com \
  --preset=eu-vat --time-zone=Europe/Berlin
```

The password comes from the environment so it stays out of the shell history. Leave `SAIL_ADMIN_PASSWORD` unset with the `oidc` provider: the email is pre-authorised instead. An optional six digits after the email set the Admin's POS PIN.

## Signing in and out

The sign-in page takes an email and a password. Sessions last 12 hours; **Sign out** in the user menu ends the session on the server as well as in the browser. **Change password** is in the same menu and ends your other sessions.

An unknown email and a wrong password get the same answer. Five failed attempts lock that email for 15 minutes, and twenty from one address lock the address; the counters live in Postgres, so they hold across API machines and restarts.

The address lock counts the address the API sees. When the API is reached only through the web app or a proxy that sets `X-Forwarded-For`, set `TRUST_PROXY=1` so it counts the browser's address (the last entry) instead of the proxy's. Do not set it when callers can reach the API directly, because they could then choose their own address. The web app passes on the header it receives, so put a proxy in front of it that overwrites `X-Forwarded-For` with the real client address. Without one, a caller can send a different address on every attempt and dodge the address lock; the email lock still applies. Without `TRUST_PROXY`, every sign-in through the web app shares the web server's address, so twenty failures from anyone lock web sign-in for everyone for 15 minutes.

## Adding people

Admins manage access from **Team**: open a staff member and use **Back-office access**. It works from a back-office session only, never from an Admin's PIN on the POS. The person needs an email on their staff record; an existing POS PIN is kept.

- **Invite to the back office** gives a link, shown once, that works for 7 days and only once. Send it to the person yourself; they choose a password and are signed in. Generating a new link cancels the old one.
- **Password reset link** works the same way for someone who already has a password, valid for 24 hours. Using it ends all their earlier sessions. Sail sends no email.
- Deactivating a staff member also ends their sessions and open links; reactivating does not bring them back.
- **Revoke access** removes the login, ends every session and cancels open links. The staff record and PIN stay, and they can be invited again. You cannot revoke your own access.

One email signs in to one staff record on the whole server, so an invite is refused if another merchant's staff member already signs in with that email.

With the `oidc` provider, **Invite** pre-authorises the staff member's email instead. On their first sign-in through the identity provider with that email, Sail links the account to the staff record. Emails nobody pre-authorised are refused; Sail never creates staff from a sign-in. Tokens that say `email_verified: false` are not linked, but tokens without the claim are, so configure the issuer to issue tokens only for confirmed emails.

## Local development

`pnpm --filter @sail/server dev:local` seeds two demo Admins, `admin@sail.local` and `admin.eu@sail.local`, both with the password `sail-demo-password` and PIN `123456`. The back office signs in with them through the same local provider as production. `SAIL_DEV_EMPTY=1` starts with an empty database instead, so the back office opens on setup.
