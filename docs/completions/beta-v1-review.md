# Beta v1 review: completion note

Date: 4 Nov 2026. Branch: `feat/beta-v1`. An end-to-end review of the v0.1 to v0.9 build against `docs/sail-v0.9-scope.md`, `docs/roadmap.md`, `docs/agent-centric-vision.md` and `docs/design.md`, with fixes for everything judged necessary before the beta: money math, payments, splits, refunds and shift close; authorisation, input validation and token handling; transactions and invariants; the order-mutation latency under 20 concurrent writers; the three UIs against the design spec; test gaps; dead code and doc drift. Every fix has a test. The deterministic register core (pure pricing, allocation and refund functions in `shared`) is unchanged except for one semantic correction, recorded as reference case R153.

## What

| # | Area | Finding | Fix | Test |
|-|-|-|-|-|
| 1 | Money, stock | Daily caps and "sold out for today" used the **calendar date** in the stock list and the compiled menu (and a hard-coded Singapore zone) while `lines.add` and `rounds.submit` used the **business date**. Between midnight and the cutoff a capped item showed as available on every menu and the register then refused it; the baseline suite had one failing test for exactly this reason. | `services/business-day.ts` is the one source of "today"; `compileMenu` and the stock routes use it and the merchant's time zone. | `review.test.ts` (cutoff moved ahead of the clock) |
| 2 | Money, pricing | After a bill was paid, later re-prices could **change the paid bill's lines**: a capped rule spreading over a new line, a fixed-per-order fee re-spread, a customer attached, a scheduled rule switching on, a manual item discount or quantity edit on a paid pending line. The only guard was the commit-time sum trigger, which surfaced as an opaque 422 (or 500) and in some flows made it impossible to add lines after a payment. | `repriceOrder` never gives the engine a line on a paid bill: stored amounts and adjustment shares are carried over, the engine prices the unpaid lines with each capped rule's **remaining cap**, and the halves are merged. Edits aimed at paid lines are refused early with `check_locked_by_payment` and the bill's name (`lines.update`, `adjustments.apply_manual` with `line_ids`, `adjustments.remove`). Fixed-per-order fees are now freezable (`isFreezable`). | `review.test.ts` (paid bill never changes; remaining cap), reference case R153, `pricing-semantics.md` §5.1 |
| 3 | Payments | The first payment re-prices the order (freeze) but validated the amount against the **check row read before** the re-price. A scheduled rule that switched on since the last edit produced a `paid_total > total` CHECK violation instead of a clear answer. | Re-read the bill after the freeze; non-cash over the new balance is a `validation` error carrying `details.balance`; cash is applied to the new balance with change. Remedies show money, not cents. | `review.test.ts` (scheduled rule between edit and payment) |
| 4 | Payments | `orders.reopen` reversed payments that already had **refunds** against them, so the customer could be refunded and then recharged in full. | Refused with `order_has_refunds`. | `review.test.ts` |
| 5 | Splits | `checks.allocate` with `add_checks` pruned the new empty bill, so the POS re-split the whole order evenly to add a bill, destroying the by-item allocation. | `syncAllocations` keeps empty bills; re-split and unsplit replace the set. The POS now adds a bill in place. | `review.test.ts` |
| 6 | Reports | Void value in the Z-report and the void report ignored paid modifiers. | Migration `0018_review_fixes.sql` replaces `report_voids`; the Z-report uses the same formula. | `reports.test.ts` (unchanged values for unmodified lines) |
| 7 | Security | Re-pairing a station did **not** invalidate the old station token: the resolver checked that a hash existed but never compared it. | Compare `sha256(token)` with the stored hash (as the relay resolver already did). | `review.test.ts`; `security-review-tokens.md` corrected |
| 8 | Robustness | A proposal approval replays the frozen request in-process; the nested request took a **second admission-gate slot**, so `TX_MAX` concurrent approvals would deadlock the gate, and a queued request waited forever. | Nested requests skip the gate; queued requests give up with 503 after `QUEUE_WAIT_MS` (default 10 s); `release` is idempotent; `/health` exposes `gate.timed_out`. | `review.test.ts` (`TX_MAX=1` approval; gate timeout) |
| 9 | Robustness | Concurrent requests with the same `Idempotency-Key`: the loser's insert failed and **aborted the transaction**, so the replay lookup threw "current transaction is aborted" and the caller got a 500. | The insert runs in a savepoint; losers wait for the winner's commit and replay its response. | `foundations.test.ts` (five racers, all 201, four replayed) |
| 10 | Validation | Merchant settings accepted any `timezone` (an unknown zone makes `Intl` throw on every request), any cutoff string, any GST rate and any rounding increment. | Validated: IANA zone, `HH:MM`, 0 to 10000 bps, increment in {1, 5, 10, 50, 100}. Denomination counts must add up to the cash total they accompany. | `review.test.ts` |
| 11 | Validation | `AppError.validation(message, { remedy })` buried the remedy inside `details` at 15 call sites, so the UIs could not show it. | The helper lifts `remedy` out and keeps the rest as details. | guest and POS error paths |
| 12 | Concurrency | `orders.quote` (a read) took the order's `FOR UPDATE` lock. | Plain read. | `review.test.ts` (quote returns while another connection holds the row) |
| 13 | Latency | Under 20 writers at one outlet the per-outlet sequence lock was taken by the **first** event of a transaction and then held through the re-price, the snapshot, the per-row deferred sum triggers at commit and the commit itself, serialising every writer at the outlet. | Events are appended **last**; `settleInvariants()` fires the deferred triggers before the first append (and `assertNotSettled` forbids money writes after it); `appendEvent` is one statement; re-price and allocation writes are batched; independent reads are pipelined. | load test, full suite |
| 14 | Guest | Re-checking whether the table was ready cost a new rate-limited session every 15 s, so an unseated guest was locked out after a few minutes. | `GET /v1/guest/order` binds a pre-seating session to the table's order once one exists and returns `can_order`; the guest stream then opens. | `guest.test.ts` |
| 15 | API, for the UIs | Clients were adding cents up for figures the register did not return. | Added `payment.due_cents`, Z-report `tenders_summary`, snapshot `refunded_total`, print job `round_no`. | web smoke scripts (manual), typecheck |

Web, guest and relay findings are summarised in "UI and relay" below; they were reviewed and fixed package by package.

## Where

| Piece | Path |
|-|-|
| Business date service | `packages/server/src/services/business-day.ts` (re-exported from `routes/org.ts`) |
| Paid-bill merge, batched persistence, pipelined reads | `packages/server/src/services/orders.ts` (`repriceOrder`, `lockedLineIds`, `loadSnapshot`) |
| Allocation rebuild (kept empty bills, batched), paid-adjustment guard | `packages/server/src/services/checks.ts` |
| Payment validation after the freeze, reopen guard, money remedies | `packages/server/src/services/payments.ts` |
| Deferred-trigger settlement and the write-order guard | `packages/server/src/db/client.ts` (`settleInvariants`, `assertNotSettled`) |
| Event append as one statement | `packages/server/src/lib/events.ts` |
| Events-last ordering in every mutation | `routes/orders.ts` (`finish` with pending events), `routes/payments.ts`, `routes/splits-refunds.ts`, `routes/guest.ts` |
| Station token hash check | `packages/server/src/auth/resolve.ts` |
| Gate timeout, nested requests | `packages/server/src/lib/gate.ts`, `middleware/pipeline.ts`, `config.ts` (`QUEUE_WAIT_MS`) |
| Idempotency savepoint | `packages/server/src/middleware/idempotency.ts` |
| Settings validation | `packages/server/src/routes/org.ts` |
| Void value with modifiers | `packages/server/drizzle/0018_review_fixes.sql`, `services/shifts.ts` |
| Guest session binding | `packages/server/src/services/guest.ts` (`bindSessionToTableOrder`), `routes/guest.ts` |
| Freezable fixed-per-order fees | `packages/shared/src/pricing/engine.ts` (`isFreezable`), reference case R153 in `cases-freeze.ts` |
| Regression tests | `packages/server/test/review.test.ts` (11 scenarios), additions to `foundations.test.ts` and `guest.test.ts` |
| Spec and manifest | `packages/server/openapi.json`, `mcp-tools.json` (regenerated; 146 paths, 103 tools) |

## How

**The paid-bill merge.** The engine stays a pure function of its inputs. The server decides which lines it may price: those on unpaid bills. For each rule with a cap, the cap passed to the engine is the original cap minus what the rule already took on paid lines, so the cap holds for the whole order. After pricing, each stored adjustment's paid-line amounts are appended to the matching engine adjustment (same rule key, version and manual application) or carried as their own row when the rule no longer applies to any unpaid line. Order totals are sums over both halves. The database still asserts every sum at commit; the merge is what makes those assertions pass by construction rather than by luck.

**The critical section.** Every mutation now runs in this order: lock the row, validate, write the money tables, bump the version, load the snapshot, `settleInvariants()`, append events, respond. `settleInvariants()` runs `SET CONSTRAINTS ALL IMMEDIATE`, which fires the deferred sum triggers at that point instead of at commit; after it, any money write throws, so the ordering cannot silently regress. The outlet's sequence lock is therefore held for the appends and the commit only.

**Measured locally** (`pnpm --filter @sail/server load:local`, 20 stations × 10 orders, 50 SSE streams, `TX_MAX` 16, embedded Postgres, load generator and server in one Node process):

| Operation | Before p50 / p95 / p99 ms | After p50 / p95 / p99 ms | Uncontended p50 ms |
|-|-|-|-|
| orders.open | 133 / 797 / 1073 | 120 / 394 / 515 | 13 |
| lines.add | 137 / 593 / 938 | 148 / 416 / 564 | 23 |
| orders.fire | 147 / 833 / 1198 | 126 / 391 / 556 | 17 |
| payments.record | 184 / 619 / 1774 | 140 / 402 / 625 | 23 |
| orders.get | 34 / 63 / 78 | 30 / 47 / 58 | 4 |

Throughput rose from 126 to 177 requests/s with no gate rejections. The remaining gap to the 300 ms p95 target is not locking: reads that take no locks inflate 7× under the same load, which is the single event loop shared by the load generator and the server, and one small Postgres. The structural fixes are what carry over to staging; the number to confirm there is the p95 from a separate load-generating process against Fly in `sin` and Supabase in `ap-southeast-1`.

**Tests.** Server 129 (was 117; one was failing at the start of the review because of finding 1), shared 278 (reference set 153 pricing cases plus 24 split and refund cases), relay 11 (was 3). `openapi:check` and `manifest:check` pass; the migration drift check is clean (0018 is hand-written). Both contract smoke scripts pass against `dev:local` with the reviewed UIs' wrapper functions: `pnpm --filter @sail/web pos:smoke` (the reopen section now expects `order_has_refunds` on the refunded order and reopens a fresh takeaway order instead) and `pnpm --filter @sail/guest smoke`. Every package typechecks and the web, guest and server bundles build.

## UI and relay

Two reviewers audited the front ends against `docs/design.md` and fixed what was safe within their packages; their findings are in `git log` for this branch and summarised here.

**POS and back office (`packages/web`, `packages/ui`).** Critical: auto-lock never fired (the idle effect re-armed itself on its own warning). High: register errors raised from inside sheets were hidden behind the sheet scrim (a silent failure for every error in Remove, Void, Discount, Reopen, Cancel, Move table, Customer and Refund); client-side money arithmetic in the payment panel, bill footer, refund sheets, order header and Z-report card total, all replaced by register figures (two needed the new API fields above); the add-a-bill workaround. Medium: new orders and refunds generated a fresh id per tap (a retry after a timeout opened a second order or refunded twice), search results bypassed tile access levels, the closed-orders list never refreshed from events, reroute had no Undo, the Done-screen timer restarted on every refetch, counter-station failures were silent, totals and alerts lacked live regions, placeholders for Changes and Assistants read as missing features. Dead code removed. Left as follow-ups: back-office compact buttons under 44 pt, tile access levels have no override action (wording says "Manager approval"), reprint matches tickets by round now that jobs carry `round_no`.

**Guest app (`packages/guest`, `packages/ui/src/guest`).** High: concurrent 401s flipped the page to "ended" mid-recovery and a paid order silently re-created a session; the can-order poll burned the per-device session limit (now mitigated client-side and fixed server-side, finding 14). Medium: the item sheet's Add button was unreachable for VoiceOver while a choice was missing (now reads "Choose 1 more: Protein" and focuses the group), required grandchild modifier groups were neither enforced nor sent, menu rows hid the price from screen readers, order-view errors were swallowed, call-staff rate limits showed custom copy instead of the register's remedy, view changes moved no focus. The design 4.11 comparison found the screens match; the deliberate deviation is that the basket bar shows no total (the UI never adds cents).

**Relay (`packages/relay`).** High: every outstanding job for a printer was sent in parallel (most printers accept one connection; tickets could interleave), now one at a time per printer with printers in parallel; a socket error after connect could hang a job forever and keep it out of the server's re-queue; a silently dead stream was never torn down. Medium: a transient failure wasted a 4 s sleep on the last attempt and an unacknowledged success produced a duplicate ticket (acks now retry), shutdown left claimed jobs for the 60 s worker (now re-queued on stop), boot crash-looped on a transient API error and a superseded token looped on 401 (now re-pairs from `SAIL_RELAY_PAIRING_CODE` or logs the instruction), every job frame triggered a full fetch, heartbeat probes were sequential and could overlap. Seven relay tests added with an in-memory register and fake printers.

## Why

The scope doc makes the pricing pipeline the top correctness risk and names the invariants that must hold whoever presses the buttons (§6): checks add up to the order, refunds never exceed what was paid, a paid check never changes under the customer. Findings 2 to 5 were places where those invariants were enforced only by the commit-time triggers, which protects the ledger but fails the person at the till with an opaque error or a stuck order. Moving the guards to the primitives, and making the server rather than the engine responsible for which lines may be re-priced, keeps the register deterministic and the engine pure while giving every refusal a name and a remedy (vision §2, principle 11). The latency work follows from the same design: the per-outlet sequence lock exists so commits deliver in sequence order (scope §7.1 rule 7); it has to be held briefly, which means money first, events last.

## Exit criteria touched

| Criterion | Status |
|-|-|
| Pricing reference set ≥ 150 cases; checks add up to the order to the cent | Met: 153 pricing cases plus 24 split and refund cases; the paid-bill merge adds API-level cases for the sums after a payment. |
| p95 API latency under 300 ms from Singapore | Still **blocked** on staging. Locally the mutation p95 fell from 593 to 833 ms to 391 to 416 ms under 20 writers; uncontended mutations take 13 to 23 ms. |
| Security review of token scopes | Updated: station re-pairing now invalidates old tokens; PIN lockout documented as per station. |
| Full service day, print drills, QR on devices, walkthroughs, Finance review, backups, alerting | Unchanged: **blocked** on staging, hardware, the outlets and Finance (see the phase notes). |

## Remaining, in priority order

1. **Staging measurement** of the mutation p95 from a separate load generator (the local harness is CPU-bound); then size Fly machines, `TX_MAX` and `DB_POOL_MAX`. If the per-outlet lock still dominates, the next step is one sum check per order per transaction instead of one per row (a marker in a transaction-local setting), which the trigger functions can be given in a migration.
2. **QR sheets rotate every table token on each print** (`GET /v1/outlets/{id}/qr-sheet.pdf`): reprinting a sheet mid-service invalidates the codes on the tables. Store the token (or make rotation an explicit action) before install day; until then print the sheets once and rotate single tables from the Floor page.
3. **Masked customer contact views for agents** and per-identity amount ceilings (security review finding 7).
4. **Tile `access_level` has no override action**; either add one (`lines.add_restricted_tile`) or change the tile wording.
5. **Back-office compact controls** below 44 pt on Today and the order drawer; desktop only.
6. **Guest round progress**: Accepted and Preparing collapse into one step; needs a kitchen bump in v1.0.
7. **Relay `HEALTHCHECK`** in the Dockerfile once a probe endpoint is chosen; shared PIN-lockout and guest rate-limit stores across API machines (both are per process today).
8. **Reports**: plain views stay fine at beta volume; revisit materialised views when a report exceeds a second on production data (as recorded in the v0.9 note).

Nothing in this review names any other POS product; the forbidden-term sweep (`grep -rniI` for the incumbent's name) returns no hits.
