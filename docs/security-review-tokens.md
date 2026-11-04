# Security review: token scopes and principals

Status: v0.9, 4 Nov 2026. Reviewer: Engineering (self-review before the beta; an external review is recommended before v1.0). Scope: every bearer token the API accepts, what it can reach, how it is issued, how it ends, and how the database limits it independently of the application code.

## 1. Principals at a glance

| Token | Issued by | Lifetime | Bound to | Postgres role | Ends |
|-|-|-|-|-|-|
| Back-office session (Supabase JWT, or `DEV_AUTH_SECRET` dev JWT outside production) | Supabase Auth | Supabase default (1 h, refreshable) | A `staff` row by `auth_subject`; role, outlet and brand scope from the row | `app_authenticated` | Supabase sign-out; staff deactivated (`active = false`) |
| Station token (`typ: station`) | `stations.pair` with a single-use 6-digit code (15 min) | No expiry | One station (outlet, brand); hash stored on the station | `app_authenticated` with no role: menu, layout, floor reads only | Re-pairing replaces the hash; archiving the station |
| PIN session (`typ: pin`) | `staff_sessions.start` with a station token and a PIN | 14 h, plus inactivity expiry (server-side) | The staff member, the station, its outlet; role from the staff row | `app_authenticated` | Sign-out, expiry, lockout after repeated failures |
| Guest token (`typ: guest`) | `guest_sessions.create` from a table QR token (public, rate-limited) | 4 h | One table, one channel link, the table's open order | `app_guest`: catalogue and own order reads only | Order completes or cancels (hook), expiry, worker sweep |
| Relay token (`typ: relay`) | `relays.pair` with a single-use code | No expiry | One relay (outlet); hash stored | `app_relay`: print jobs and heartbeat only | Re-pairing, archiving |
| Agent token (`typ: agent`) | `agent_sessions.start` with an identity credential, optional on-behalf-of | 15 min | One identity, one task; effective role and scope = intersection with the human | `app_agent`: operational tables, no secrets, no config writes | Expiry, identity disabled (kill switch), credential rotation |
| Override grant (not a token: a single-use row) | `overrides.grant` with the approver's PIN | 120 s | One action, one target, one requester | n/a | Consumed once, or expiry |

All Sail-issued tokens are HS256 JWTs with a `typ` claim and **separate secrets per type**, so a leaked guest secret cannot mint station tokens. The type is peeked before verification only to select the secret; the signature is always checked with that type's secret.

## 2. Findings

| # | Area | Finding | Severity | Status |
|-|-|-|-|-|
| 1 | Station tokens | No expiry by design (an iPad must survive a week unattended). Mitigation: the token alone grants no money operation (no role); every money operation needs a PIN session; re-pairing invalidates it. The Beta v1 review found the resolver did not compare the presented token with the stored hash, so re-pairing did **not** invalidate older tokens; fixed and covered by a test (`test/review.test.ts`). | Low | Accepted. v1.0: rotate on each PIN sign-in. |
| 2 | PIN sessions | 14-hour lifetime is long. Mitigation: server-side inactivity expiry and auto-lock on the device; the session is bound to one station and outlet. | Low | Accepted. Inactivity window is a merchant setting. |
| 3 | PIN brute force | 6-digit PINs, lookup by HMAC and scrypt hash; lockout after 5 wrong PINs **per station** (30 s, in-process). A wrong PIN cannot be attributed to a staff member (the lookup is by the PIN itself), so the per-staff `pin_failed_attempts` columns are unused. | Medium | Met. v1.0: alert on lockouts; share the lockout across API machines. |
| 4 | Guest tokens | Scope is one table and its open order; `app_guest` cannot read payments, checks, refunds, staff or other tables (RLS replay case). A photographed QR cannot create an order unless the channel link allows open-on-first-scan. Table tokens rotate from the back office and on every QR sheet. | Low | Met. |
| 5 | Guest writes | Guest mutations run as the register (`SET LOCAL ROLE app_authenticated` inside the request) after validation under the guest token. The surface is three handlers (round, request, session). Risk: a bug in one could act beyond the table. Mitigation: each handler re-reads the session row and uses its table and order ids only, never client-supplied ids. | Medium | Met; re-review when new guest writes are added. |
| 6 | Relay tokens | `app_relay` has grants on print jobs, relays and idempotency keys only; it cannot read orders or payments (job payloads carry the rendered ticket). | Low | Met. |
| 7 | Agent tokens | 15-minute, task-bound; identity ceiling T0 to T2 with T3 never reachable; on-behalf-of takes the lower role and the intersection of outlets; `app_agent` has no access to PIN hashes, token hashes, auth subjects, customer contact columns, session or pairing tables, and cannot write configuration tables (RLS replay case and agent test). Rate limits per session and per identity (operations, proposals per day). Kill switch disables live sessions at once. | Medium | Met for v0.9. Open: masked customer views for agents (v1.0), per-identity amount ceilings. |
| 8 | Proposals | Frozen request replayed as the approver with the frozen idempotency key; the approver's role is checked against the operation and T3 needs Manager+; the approver cannot be the proposer; expiry 10 min; a changed target fails with version_conflict. Rationale is stored as untrusted text. | Low | Met. |
| 9 | Overrides | Single-use, 120 s, bound to action and target; the approver's role must meet the action's `min_role`; accepted via header or body and verified in the handler. | Low | Met. |
| 10 | Idempotency keys | Scoped per principal and merchant in RLS; replay returns the stored response; conflicting bodies 409. | Low | Met. |
| 11 | Dev token endpoint | `/v1/auth/dev-token` is on the RLS opt-out list and disabled when `NODE_ENV=production` (config check). | Medium | Met; CI guard test on the opt-out list. |
| 12 | Public endpoints | `/health`, `/openapi.json`, pairing (single-use codes), guest and agent session starts (credential or table token), `/v1/receipts/{token}` (unguessable token, read-only document). All rate-limited at the edge in production (Fly) and in-process for guests. | Low | Met; edge rate limits blocked until Fly exists. |
| 13 | Secrets | Token secrets, Supabase keys and the database URL come from the environment; none in the repo; `.env.example` lists them. Agent credentials are shown once and stored hashed (scrypt). | Low | Met. |
| 14 | Logging | Request logs carry request and correlation ids, never tokens or PINs; 403 RLS refusals are logged with the SQL error, not the data. | Low | Met. |
| 15 | Transport | HTTPS only in production (Fly and Vercel terminate TLS). CORS is open for the API in development; production sets `CORS_ORIGIN` to the web app origins. | Low | Met in config; verify at deploy. |

## 3. Actions before go-live

1. Set `CORS_ORIGIN` to the production web origins and confirm the dev token endpoint returns 404 in production.
2. Rotate every table QR token by printing fresh sheets on install day.
3. Create agent identities with the narrowest toolsets that the beta needs (reporting analyst: `reports` only, ceiling T0), and leave the cashier assistant disabled until the agents-off service day has passed.
4. Enable Supabase MFA for Admin and Finance back-office accounts.
5. Schedule an external penetration test before v1.0, focused on the guest and agent surfaces.
