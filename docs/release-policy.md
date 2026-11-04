# Release and rollback policy

Status: v0.9, 4 Nov 2026. Applies to the API (Fly.io), the web apps (Vercel: back office and POS in `web`, the guest app in `guest`) and the relay image.

## 1. When we deploy

- **Never during service hours.** Each outlet's service window is recorded in its outlet settings (`hours`). The release window is 06:00 to 10:30 Singapore time, after the business-day cutoff (04:00) and before lunch prep, Monday to Thursday. No releases on Fridays, weekends or public holidays, or the day before one.
- **Staging first, always.** Every change ships to staging on merge to `main` (`deploy-staging` job) and sits there through at least one simulated service (the dress-rehearsal script, or the smoke scripts in `packages/web/scripts` and `packages/guest/scripts`) before it goes to production.
- **Production is a manual approval.** The `deploy-prod` job runs only from a tagged release (`v0.9.x`) with the `production` environment approval by Engineering and an Ops lead, and only when `vars.DEPLOY_ENABLED` is set. Both beta outlets are told the night before.
- **Hotfixes** (an outlet cannot trade, money figures wrong, printing down with no workaround) may go during service with two people on the call: one deploying, one watching the outlet. The fix is the smallest possible change, deployed to staging first even if only for ten minutes.

## 2. Order of operations for a release

1. CI green on `main`: typecheck, tests (shared, server, relay), `openapi:check`, `manifest:check`, migration drift, forbidden-term scan, builds.
2. Read the migration files added since the last tag. **Migrations must be backwards compatible with the running API**: add columns and tables, never rename or drop in the same release that stops using them; views are replaced with `CREATE OR REPLACE`. Drops wait one release.
3. Tag `vX.Y.Z` on `main`. Write the release note in `CHANGELOG.md` (it is the list of completion notes since the last tag).
4. **API**: `fly deploy` runs migrations in the release command before new machines take traffic; the `app`, `worker` and `mcp` process groups roll one machine at a time. Watch `/health` and the 5xx rate for 10 minutes.
5. **Web apps**: promote the Vercel preview of the tagged commit. The back office and POS read the API's `openapi.json` at build time (`gen:api`), so a web release always follows the API release that introduced the contract it uses. Stations reload on the next unlock; the POS shows "Updating…" while it fetches the new build.
6. **Relay image**: build and push `sail-relay:vX.Y.Z` from `packages/relay/Dockerfile`. Relays are updated outlet by outlet, out of hours, by `docker pull` and recreating the container (the token lives in the `sail-relay-data` volume, so no re-pairing). The back office shows each relay's version; a release is not done until every relay reports it.
7. Confirm on production: sign in, open and cancel a test order at a test table, test print to each printer, read the Z-report for the previous day. Record the release in the ops log.

## 3. Rollback

- **API**: `fly releases` → `fly deploy --image <previous image>` for the `app`, `worker` and `mcp` groups. Because migrations are additive, the previous image runs against the newer schema. If a migration must be undone, write a new forward migration that reverses it; never edit or delete an applied migration file.
- **Web apps**: Vercel "Promote previous deployment". The previous build matches the previous API contract, so roll the web app back first if the API stays, or both together if the API rolls back too.
- **Relay**: recreate the container with the previous tag. Queued jobs are on the server; nothing is lost.
- **Data**: the Supabase project is configured for daily backups and point-in-time recovery (**confirmation blocked** until the project exists; see the v0.9 completion note). A restore is a last resort and is a Finance decision as well as an Engineering one, because it rewinds sales.

## 4. Who decides

| Decision | Who |
|-|-|
| Ship a release to production | Engineering lead and an Ops lead, both named in the approval |
| Hotfix during service | Engineering lead, with the outlet manager informed |
| Restore from backup | Engineering lead, Finance and the merchant owner |
| Cut scope before a release | The merchant owner, per the roadmap's cut order |

## 5. What never changes without a review

The pricing engine (`packages/shared/src/pricing`), the money allocators (`splits.ts`, `refunds.ts`), the database invariants (deferred triggers), the RLS policies, the operation manifest (`x-sail`, `mcp-tools.json`) and the reference set. A pull request that touches any of these needs a second reviewer and the reference set must grow when behaviour changes.
