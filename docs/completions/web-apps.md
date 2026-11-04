# Web apps: completion note (back office, iPad POS, guest app)

Date: 4 Nov 2026. Branch: `feat/beta-v1`. Covers the UI work for roadmap phases v0.1 (shell), v0.3 (catalogue, pricing, floor, import), v0.4 (POS), v0.6 and v0.7 (payments, bills, refunds, shifts), v0.8 (guest app) and v0.9 (printing, orders drawer, Today, reports). Built against `docs/design.md`; every amount shown comes from the register.

## What

- **Back office** (`packages/web`, Next 15 App Router): sign-in (Supabase or the dev token), Today as "what needs a person now" (service list, QR rounds to accept or reject, table requests, late tickets with reroute, relays offline, open shifts, quiet Z tiles), Orders (today and all, filters, read-only drawer with bills, payments, refunds, tickets, events and audit; actions by role: refund stepper from the register's quote, reopen, receipt and invoice PDFs, credit notes, reprints), Menu (products with search and filters, bulk price, modifier groups, menus with drag-and-drop sections, categories, availability, sold out, legacy CSV import with dry run and summary-first review), Pricing (rules with versions and plain-language editor, simulator with trace, customers and groups, tax and rounding), Floor (areas, grid table editor, QR sheets and per-table rotation), Printing (printers with routing coverage warnings and test print, relays with pairing code and the install snippet, print jobs with preview, reprint, reroute), Reports (Z-report with close business day, shifts), Settings (outlets, brands, stations with "Pair an iPad", channels, tenders, void reasons, merchant, team, audit). Changes and Assistants remain placeholders.
- **iPad POS** (`/pos`, client-only, standalone web app): pairing, lock screen with PIN pad, Floor with live tables, Orders with takeaway/pickup/delivery sheets, Order screen (section rail, tiles with sold-out and caps, modifier panel, seat strip, rounds, totals with register names, action dock, line and discount sheets, order menu), manager approval sheet, undo toasts, event store over SSE with catch-up and version conflicts, Day and Service themes, wake lock and auto-lock. Payments, bills, refunds and shift screens: see the section below.
- **Guest app** (`packages/guest`, Next 15 on port 3001): `/t/{token}` with brand theming, menu with sticky section tabs, item sheet with required groups first, basket and review, send to kitchen with idempotent retry, status page with the round timeline and live updates, "Our table", call staff and ask for the bill; `/r/{token}` digital receipt; no login and no payment anywhere.
- **Shared UI** (`packages/ui`): tokens and themes from the design spec; back-office, POS and guest component sets.

## Where

| Area | Path |
|-|-|
| Back office routes and components | `packages/web/src/app/(backoffice)/**`, `packages/web/src/components/backoffice/**`, `packages/web/src/lib/nav.ts` |
| POS | `packages/web/src/app/(pos)/**`, `packages/web/src/pos/**` (api, stores, events, hooks, screens), `packages/ui/src/pos/**` |
| Guest app | `packages/guest/**`, `packages/ui/src/guest/**` |
| Generated API client | `packages/web/src/lib/api/schema.d.ts`, `packages/guest/src/lib/api/schema.d.ts` (`pnpm --filter <pkg> gen:api`) |
| Smoke scripts (run against `pnpm --filter @sail/server dev:local`) | `packages/web/scripts/pos-smoke.ts`, `packages/guest/scripts/guest-smoke.ts`, back-office smoke in the agent's scratchpad (API round trips through the Next proxy) |

## How

- The web apps talk only to the register. The back office proxies `/api/v1/*` with an httpOnly session cookie; the POS and guest app call the API directly with their own tokens (station and PIN sessions in storage; guest token in sessionStorage). Idempotency keys are generated per logical action and reused on retry; `expected_version` is sent on every order edit; override grants travel as `override_id`.
- Types for the open-record parts of the spec (order snapshot, floor, menu, documents) are mirrored by hand from the server source until the spec types them (gap listed below).
- No client arithmetic: the basket bar says "Review 3 items" without a total; bill, payment, refund and shift screens show register figures only, including cash rounding and change from a dry run.
- Verification: `pnpm --filter @sail/ui typecheck`, `pnpm --filter @sail/web typecheck && build`, `pnpm --filter @sail/guest typecheck && build`; smoke scripts: POS 48 steps, guest 25 steps, back office 62 of 66 then 31 of 31 API checks after the server fix to demo rule bodies. No browser-level rendering was possible on this host (no Chromium system libraries), so visual checks and the iPad walkthrough are outstanding.

## POS payments, bills, refunds and shift (v0.6, v0.7, v0.9 screens)

- **Bill screen**: One / Even / By seat / By item segmented control; even stepper 2 to 20 with per-bill amounts from the response; shared lines even or manual; tap a line then a bill, "Share between bills…" for equal shares; "Bills add up to $X" from the returned check totals, "Checking…" while a request is in flight; paid bills locked with their tenders; Pre-bill and Pay per bill; Print all pre-bills; modes the register refuses are disabled with its reason.
- **Payment**: tender types with the top three as buttons and the rest under More; amount prefilled with the balance and editable for part payments; cash Exact and next-notes with a dry run showing rounding and change before the real payment; card and PayNow at 34 pt with the terminal instruction and a reference field; the payment id doubles as the idempotency key; Done screen with Print, QR on screen, Email or SMS, No receipt, Get invoice and a 4 s return.
- **Refund stepper**: bill → what (whole, items with steppers, amount) → why (void reasons marked for refunds first, plus text) → back to (quote tenders, editable) → review from the register's quote → "Refund $X" or "Manager approval" through the override sheet; entered from the order menu, a paid bill or a closed order.
- **Shift**: open with a cash counter (total or denominations, default from the last close); close with a checklist read from the register (open orders, pending QR rounds, late tickets, open requests), blind count before expected is shown, variance with a reason above $5; Z-report with the card total at 34 pt and the terminal reminder, Close business day for Manager+; Sold out (today, until, indefinitely, restore, cap); Printers (relay and printer status, late jobs, reprint).
- **Print failure banner**: late jobs polled every 10 s while any are late and on `job` stream events; Send to backup, Retry, Details; relay-offline wording; green recovery for 5 s; round headers show late, printing and printed marks.
- **Now rail and Scan to Order on the POS**: QR rounds with Accept, View and Reject (one-tap reason), table requests with Done, pickups with Collected; sound off by default; the order sheet groups a pending round with Accept and Reject and marks guest lines; the order menu gains Refund, Reopen, Get invoice and Reprint ticket; completed orders stay viewable under "Today's closed".
- Verification: ui and web typecheck and `next build` pass; the POS smoke script covers even split, item move, three-way share, pre-bill, card part payment, locked split, cash dry run matching the real payment, auto-complete, QR receipt link, invoice, line refund with override and credit note, reopen with override, shift open and close with expected cash including rounding, late jobs and reroute, guest round accept and reject, request acknowledge.
- Register behaviour noted for v1.0: a refused split returns `invariant_violation` with `details.invariant = check_locked_by_payment`; reopening an order reverses all its payments (and is refused once a refund exists); there is no Z-report print endpoint; the $5 variance threshold is a POS constant. (The Beta v1 review changed `checks.allocate` so `add_checks` keeps the new empty bill; the POS now adds a bill without re-splitting.)

## Why

The design spec asks for a self-explanatory, iPad-first UI where staff never do arithmetic and every risky action has one obvious path (reason, approval, undo). Splitting the UI into back office, POS and guest packages keeps each surface small and lets the guest app ship with the brand's look while the POS stays a tool.

## Exit criteria touched

| Criterion | Status |
|-|-|
| v0.3 Admin edits a product price in the back office and the simulator shows the result | Met (products sheet, simulator). |
| v0.4 Two stations edit the same order; the second sees `version_conflict` and recovers | Met in the POS (unversioned add retried once with "Your new line was kept"; other edits refresh). |
| v0.4 Tap budgets (open to fired in ≤ 6 taps; 1-tap add) | Met by design; measured in the walkthrough (**blocked**: iPad). |
| v0.8 Guest flow on iOS Safari and Android Chrome; printed sheet scans | **Blocked**: devices. The pages render and the smoke flow passes. |
| v0.9 Today and the full orders drawer; remaining setup screens | Met. |
| Staff walkthroughs since v0.4 | **Blocked**: no outlets or staff available in this environment. |

## Server gaps found by the UI work (fixed or open)

Fixed during the build: demo pricing-rule bodies were double-encoded in the standalone seeds; `GET /v1/outlets/{id}/events?aggregate_id=`; availability rule delete; `dev:local` now runs the worker; digital receipt links point at the guest app.

Open, recorded for v1.0: order snapshot, floor, menu and document schemas are open records in the spec (clients mirror the types); no override action for tile `access_level` other than open price; no `GET /v1/outlets/{id}`; print jobs carry no `order_no` or printer name; two printers can both be marked default kitchen; a guest's `can_order` can only be re-checked by starting a session (rate-limited), and `GET /v1/guest/order` binds to the order only after the first round; modifier validation errors carry `group_id` but not `line_id`; no server-side curated list for `brand.display_font`.
