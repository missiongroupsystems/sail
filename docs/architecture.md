# Architecture

How Sail is built today. For setup see the [README](../README.md); for settings see [configuration.md](configuration.md); for deployment see [self-hosting.md](self-hosting.md).

## The register

The server (`packages/server`) is the register. It is the only thing that writes to the database and the only place money is computed. Every client is a caller of the same `/v1` API: the POS and back office (`packages/web`), the guest app (`packages/guest`), the print relay (`packages/relay`) and agents over MCP. No client reads or writes tables directly, and no client adds up amounts. Clients format the integers the register returns.

Money is always an integer in the minor unit of the merchant's currency (cents, yen, fils). Percentages are basis points (1000 = 10%).

Invariants are enforced twice: in the service code and in the database. Deferred constraint triggers check that bills add up to their order, that refunds stay within what each line and payment took, and that each adjustment's per-line amounts add up to its total. Document numbers (invoices, credit notes, refund receipts) come from gap-free per-merchant sequences.

```
POS / back office (web)   guest app   print relay   agents (MCP)
          \                  |            |             /
           +------------- /v1 API (Hono) ---------------+
           | admission gate -> one transaction -> principal -> RLS -> operation |
           +--------------------------+--------------------+
                                      |
                          PostgreSQL (RLS, triggers, pg_notify)
```

## Request pipeline

Every request goes through `packages/server/src/middleware/pipeline.ts` (steps 1 to 4) and `middleware/idempotency.ts` (step 5):

1. **Admission gate** (`lib/gate.ts`). At most `TX_MAX` request transactions run at once; up to `QUEUE_MAX` wait for `QUEUE_WAIT_MS`; beyond that the API returns 503 `overloaded`.
2. **One transaction per request.** A response of 400 or above, or a dry run, rolls it back.
3. **Principal.** `auth/resolve.ts` turns the bearer token into a principal (staff, station, guest, relay or agent).
4. **RLS context.** `set_config('app.current_merchant' | 'app.current_outlets' | 'app.current_principal' | ...)` and `SET LOCAL ROLE` to the principal's database role.
5. **Idempotency.** Every `POST`, `PUT`, `PATCH` and `DELETE`, except the public pairing and session-start routes and the streams, needs an `Idempotency-Key` header. A repeat with the same body replays the stored response; the same key with another body is `idempotency_conflict`.
6. **The operation.** `defineOp` (`lib/openapi.ts`) checks the principal kind and the minimum role from the manifest before the handler runs. Handlers add only the checks the manifest cannot express: manager approvals and a manual rule's own role, and the approver's role on a proposal.

Responses use one envelope: `{ data }` for reads, `{ data, next_cursor }` for lists and `{ data, events, warnings }` for mutations. Errors are `{ code, message, remedy, details }`; the codes are in `packages/shared/src/errors.ts`. Orders carry a `version`; edits pass `expected_version` and get `version_conflict` if someone else moved first. 38 operations accept `dry_run: true`.

A few routes run without the per-request transaction: `/health`, `/openapi.json`, the development token, the public pairing and session-start endpoints and digital receipts (`db/rls-opt-out.ts`, covered by a test). The three SSE streams check access in a short transaction and then stream outside it.

## Tenancy and row-level security

Merchant > brand > outlet > station. Every tenant table has `merchant_id`, and `outlet_id` where an outlet applies. RLS is on for every one of them, with policies built on `sail.merchant_id()` and `sail.outlet_allowed(outlet_id)`, which read the settings from step 4.

| Postgres role | Used by | Can reach |
|-|-|-|
| `app_authenticated` | Staff (back office or PIN) and paired stations | The merchant's rows within the outlet scope; what each person may do is decided by the role checks |
| `app_guest` | Guest sessions from a table QR code | Reads the merchant's catalogue and its own session, order and requests; writes only its idempotency keys |
| `app_relay` | Print relays | The outlet's printers, print jobs and the relay's heartbeat |
| `app_agent` | Agent sessions | Operational tables; no PIN or token hashes, no customer contact columns, no configuration writes |

Guest writes (send a round, call for the bill) are validated under the guest role and then written as the register, using only the ids on the guest's session row. The roles and grants are in the hand-written migrations (`packages/server/drizzle/*_rls_*.sql`). `packages/server/test/rls-replay.test.ts` finds every table with a `merchant_id` column and fails if RLS is off, a policy is missing or one merchant can see another's rows.

## Operations: manifest, OpenAPI, MCP

Each operation has an id of the form `group.verb` (`lines.add`, `refunds.create`). Its entry in `packages/shared/src/manifest.ts` (or a module's `registerOperations` call) holds the risk tier, minimum role, override and reason rules, dry-run support, allowed principals, emitted events and MCP exposure. Roles and the permission matrix are in `packages/shared/src/roles.ts`: five fixed roles, server < cashier < manager < finance < admin.

From there:

- `defineOp` registers the Hono route and writes the entry into the spec as `x-sail`.
- `packages/server/openapi.json` is generated and committed (172 paths, 213 operations). `pnpm openapi:check` fails when it is stale.
- `packages/server/mcp-tools.json` is generated from the spec (112 tools) and checked by `pnpm --filter @sail/server manifest:check`.
- The front ends generate their API types from the spec (`gen:api`).

Risk tiers: T0 reads, quotes and dry runs; T1 routine and reversible (add a line, split, mark sold out, reroute a ticket); T2 consequential (send to the kitchen, record a payment, apply a discount or comp, close a shift); T3 money out (refunds, reopening), configuration and identities. Today there are 93 T0, 35 T1, 18 T2 and 67 T3 operations.

## Pricing and tax

One pure function, `price(order, rules, context)` in `packages/shared/src/pricing/engine.ts`, computes every total. It takes no clock and does no I/O. Steps: base prices, line discounts, order discounts, fees, tax, caps, largest-remainder rounding. The output is a list of adjustments with an amount per line, which splits (`packages/shared/src/splits.ts`) and refunds (`packages/shared/src/refunds.ts`) reuse, so allocation exists in one place. Order-level and minimum-spend results freeze at the first payment, and a paid bill never changes.

Tax is a set of tax classes per merchant, each with one or more rates scoped by outlet and order type; a rate is a list of named components. Prices are tax-inclusive or tax-exclusive for the whole merchant, and tax is rounded per line or once per rate. Every rule of interpretation is in [pricing-semantics.md](pricing-semantics.md). The engine is tested by a hand-calculated reference set of 162 pricing cases (`packages/shared/src/pricing/reference`) plus split and refund cases and property tests.

## Events and live updates

Every state change appends an event (`events` table) in the same transaction, with a per-outlet sequence number, the actor, any approver and a correlation id. The audit log (`audit_log`) is written alongside.

A trigger calls `pg_notify('sail_events', ...)` on commit. Each API process holds one `LISTEN` connection (`sse/listener.ts`, on `LISTEN_DATABASE_URL`) and fans notifications out to SSE streams: `GET /v1/outlets/{id}/stream` for stations, `GET /v1/relays/{id}/stream` for relays and `GET /v1/guest/stream` for guests. The stream only says that something changed. Clients catch up from `GET /v1/outlets/{id}/events?after={seq}` on connect, on a gap, when the page becomes visible and on a `resync` event, which the server sends after its `LISTEN` connection recovers (`pg_notify` is not durable). A comment line every 20 s keeps proxies from closing idle streams.

## Printing and the relay

The server renders ESC/POS bytes from templates in `packages/shared/src/escpos` (kitchen, void, reprint, pre-bill, receipt, refund receipt, service slip; 80 and 58 mm; CJK text as a raster image; golden-file tests). When items are sent, the fire transaction creates one job per target printer, routed by product tags, order type and source filters, station printers and copies, with a default kitchen printer for anything unmatched (`services/printing.ts`).

Jobs live in a durable queue (`print_jobs`): queued, claimed, printed, failed or rerouted. A job not printed within 10 s shows an alert on the POS, where staff can reprint or reroute to a backup printer. The worker re-queues stale claims.

The relay (`packages/relay`) is a small Node service on the outlet network. It pairs once with a 6-digit code, keeps an SSE stream to the API, fetches outstanding jobs on every reconnect, sends raw bytes to printers on TCP port 9100 (checking paper and cover with DLE EOT where the printer supports it), acknowledges each job and sends a heartbeat every 30 s. It holds no business logic and needs outbound HTTPS only.

## Kitchen display

A kitchen display is a station of kind `display`, paired with the same one-time code as an iPad, and opened at `/kds` on a wall monitor or tablet. It needs no PIN: the station token alone lets it read and bump the tickets of the **display destinations** it is assigned (Settings > Stations), and nothing else.

A display destination (`display_destinations`, managed on Printing > Printers) routes exactly as a kitchen printer does: include and exclude tags, order types, sources, and a default that takes what no other destination matched. Printers and destinations are routed separately, so a merchant without a destination prints exactly as before, and a destination and a printer can take the same tags (both get the item).

The fire transaction that creates the print jobs also creates the tickets (`createKitchenJobs` in `services/printing.ts`, tickets in `services/kitchen.ts`): one `kitchen_tickets` row per fire round per destination, with its `kitchen_ticket_lines` (kitchen name, quantity, modifiers, notes, seat) and the order as it was sent (number, type, table, guests, name), so a later table move does not change a ticket under the cook. The destinations and the table name are read in the same pipelined round trip as the printers, so the fire path gains the two inserts and one `kitchen_ticket.created` event for all its tickets, and nothing at all without a destination. Later changes are recorded, not edited in silently:

- Lines sent in a later fire make a new ticket (`round_no`).
- A void after sending adds to the line's `voided_quantity` on every ticket that carries it and sets `changed`; the display strikes the line.
- Cancelling the order sets its tickets to `cancelled`; they stay on the display, marked, until bumped.

A ticket is `new`, `in_progress`, `ready` (bumped), `recalled` or `cancelled`; a trigger refuses any other transition. `kitchen_tickets.start`, `.bump` and `.recall` are conditional updates (recall takes only the last ticket bumped at its destination; recalling again walks back one at a time), so a double tap, or two displays showing the same destination, move a ticket once: the later call gets the ticket back unchanged and appends no event. A fire, void or cancel appends one `kitchen_ticket.*` event on the order naming the tickets it touched, and a display action one event on its ticket. The display follows them on the outlet stream and replays from `events.list` after a reconnect. `kitchen_tickets.list` and `kitchen_tickets.all_day` are T0 and open to staff, display stations and agents; start, bump and recall are T1, for displays and staff only, and not on MCP. Guests and relays have no grant on the ticket tables. On the POS a sent line shows "ready" once every ticket carrying it is bumped.

## Auth

| Principal | How it starts | Lifetime | Ends |
|-|-|-|-|
| Back-office staff | Built in: `auth.sign_in` with email and password, which starts a session row (`backoffice_sessions`). With an external issuer: its JWT, verified against `SUPABASE_URL`'s JWKS or `SUPABASE_JWT_SECRET` and matched to a `staff` row by `auth_subject` | 12 h (built in) or the issuer's | Sign-out, password change or reset, access revoked, staff deactivated |
| Station (paired iPad) | `stations.pair` with a single-use 6-digit code | No expiry | Pairing again or archiving the station |
| Staff on a station | `staff_sessions.start` with the station token and a 6-digit PIN | 14 h, ended after `PIN_SESSION_IDLE_SECONDS` idle | Sign-out, idle or expiry |
| Guest | `guest_sessions.create` with a table's QR token | 4 h | The order completes or is cancelled, or expiry |
| Relay | `relays.pair` with a single-use code | No expiry | Pairing again |
| Agent | `agent_sessions.start` with an identity credential | 15 min | Expiry, identity disabled, credential rotated |

Sail-issued tokens are HS256 JWTs with a `typ` claim, signed per type (`auth/tokens.ts`): station and PIN-session tokens share `STATION_TOKEN_SECRET`; back-office session, guest, relay and agent tokens each have their own. A station token alone has no staff role: it reads what the lock screen needs (merchant settings, channel links, menus, layouts, outlet events) and starts PIN sessions. Everything else needs a staff member signed in with a PIN.

**Back-office sign-in.** One identity provider is active, chosen by configuration (`auth/identity.ts`): `local`, the default, or `oidc` when an external issuer is set. The local provider stores scrypt password hashes in `backoffice_logins`, which request roles cannot read, and checks the session row on every request, so ending a session takes effect at once. Five failed sign-ins lock an email and twenty lock a client address for 15 minutes, on the same Postgres counters as PINs. First-run setup (`setup.create`) works only while no merchant exists. Invitations and reset links are single-use tokens stored as hashes (`backoffice_links`). With `oidc`, an invitation pre-authorises an email and the first sign-in with it links the account. None of these operations is open to agents or can become a proposal. Setting up, invitations and lockout are covered in [self-hosting.md](self-hosting.md#sign-in).

**PINs.** Stored as an scrypt hash, found through an HMAC lookup keyed with `STATION_TOKEN_SECRET`. Five wrong PINs on a station lock it for 30 s. Sign-in PINs and manager-approval PINs count on the same counter, and each attempt is counted before it is checked; a right PIN resets the count but does not lift a lock. The counter is in Postgres (`pin_attempts`), so it holds across API machines; guest rate limits are also in Postgres (`guest_rate_hits`).

**Manager approval (override grants).** A manager enters their PIN on the requester's screen; `overrides.grant` (`POST /v1/overrides`) returns a single-use grant valid for 120 s. It is bound to the action, its target, the arguments the manager saw (void quantity, open price, rule and entered value, payment, refund and its quoted total) and the requester's PIN session and station. The protected request must repeat those arguments exactly. A manual pricing rule's own minimum role decides who may approve it. The grant id is returned only to the requester, never on the event log.

**Guest admission.** The table's QR code is a lasting shared secret, so it does not admit a phone on its own. With hold orders off, a round fires at once only from the seating's first phone and from a phone staff have accepted a round from; any other phone's round waits for a staff tap. Admission belongs to the order and the device: it follows the order to another table and ends when the order closes. With hold orders on, every round waits.

**Agents and proposals.** An Admin creates an agent identity (role, outlet and brand scope, toolsets, a risk ceiling of T0 to T2, where T2 currently acts as T1, and operation and proposal budgets). A session may act on behalf of a person, in which case its role is the lower of the two and its outlets the intersection. An agent call above its ceiling, and every T2 or T3 call whatever the ceiling, is stored as a proposal (HTTP 202, `requires_confirmation`) with the frozen request and, for an order, the order's version and total. A person with the operation's role (Manager+ for T3), who is not the proposer, approves it; the register then replays the frozen request as the approver, and only if the order is still at the version the approver saw. Proposals expire after 10 minutes. Details: [mcp.md](mcp.md).

## Front ends

`packages/ui` holds Sail's own components and tokens (`src/styles.css`), with two POS themes: Day and Service (dark, for dim rooms; a station switches at the outlet's `service_theme_from` time). The POS is designed for an iPad in landscape; the back office is desktop first; the guest app is phone first.

Three rules shape the screens:

- **Plain words.** The UI says bill, send, sold out, manager approval, payment method and table request where the API says check, fire, 86, override grant, tender and service request.
- **Friction follows the risk tier.** T1 actions run and offer Undo; T2 actions need one tap on a button that states the effect; T3 actions on the POS (refund, reopen) need a Manager or a manager's PIN; back-office configuration is Admin-only instead.
- **Money is never optimistic.** A tapped item shows at once, but totals change only when the register replies.

## Payments

A tender is recorded by hand (cash, a standalone card terminal, a house account) unless it names a payment provider and a terminal (`provider`, `terminal_id`). The provider seam is one interface, `PaymentProvider` in `packages/server/src/payments/provider.ts`: start a payment on a terminal, read its status, cancel it, void it by reference, and verify and parse a webhook. Providers register by name; the built-in `simulator` talks to the terminal simulator in `packages/server/scripts/payment-simulator.ts` and is for development and tests.

A payment on a provider tender goes through a payment intent (`payment_intents`):

```
POS ── payments.start ──> intent (pending) + outbox row, commit, 201
worker ── outbox ──> provider.startPayment ──> terminal
terminal ──> webhook (signed) ─┐
worker ── poll ────────────────┴─> applyOutcome: lock order, lock intent
      approved, same bill ──> recordPayment (the by-hand path) ──> payment.recorded, check.paid, order.completed
      approved, bill changed or intent no longer pending ──> intent cancelled + outbox void ──> provider.voidPayment
      declined / cancelled ──> intent declined or cancelled; the bill is untouched
```

What it guarantees:

- **No provider call inside a request.** `payments.start`, `payments.cancel` and `payments.void` write rows and commit; the worker makes every provider call afterwards, so a slow terminal never holds the bill's lock.
- **Pinned bill.** The intent stores the amount, the tip, the bill's total and what was already paid (and the order's version, for the record; edits to other bills of the order do not cancel it). An approval is recorded only if the provider took exactly amount + tip and the bill still has that total and that paid amount (it is checked again after the first-payment re-price). Otherwise the approval is voided at the provider and the intent is cancelled with the reason (`bill_changed`, `amount_mismatch`); nothing is applied.
- **Exactly once.** The order and then the intent are locked for every outcome, so a webhook, its duplicate and the worker's poll queue behind one another and the later ones find the intent decided. The payment's id is reserved on the intent at start, and each webhook event id is stored once (`payment_webhook_events`). An approval for an intent that is declined, cancelled or expired is voided, never recorded.
- **One payment in flight per bill.** Starts serialise on the order lock, and a partial unique index allows one pending intent per bill.
- **Timeouts.** An intent still pending after 120 s is expired by the worker and cancelled at the provider; a cancel the provider has not settled is retried. For an hour after the register gives up on an intent (declined, cancelled, expired), the worker keeps asking the provider about it, so an approval that arrives later is voided even if its webhook is lost.
- **Outbox.** Each row (`start`, `cancel`, `void`) is claimed on its own under a 60 s lease with `for update skip locked` and handled on its own. A failure doubles the row's delay (1 s, 2 s, 4 s, up to 5 minutes) and never holds up the rows after it; after 8 attempts the row is marked failed and logged, and a failed void emits `payment_intent.void_failed` on the order. When the provider later reports that void, the poll applies it, unless since then the bill was refunded, the order cancelled, or the payment's shift or day closed: the payment then stands, and `payment_intent.voided_not_applied` gives the reason (`refunded`, `order_cancelled`, `shift_closed`, `business_day_closed`) for staff to settle with the guest. A void a person asked for can be asked for again; the poll arms an unapplied approval's void again.
- **Webhooks.** `POST /v1/webhooks/payments/{provider}/{merchant_id}` carries no token. Its signature is checked first, with that merchant's secret for that provider (`payment_providers.configure`), together with a timestamp within 5 minutes. Verified deliveries count against the merchant's limit (the Postgres-backed limiter the guest app uses, 300 a minute) and refused ones against a separate limit (60 a minute), so forged requests cannot crowd out the provider's. The body is parsed as untrusted data and acted on only for an intent of that merchant and provider. A wrong signature, an unknown merchant or provider and a stale timestamp all answer 401.

**Voiding a payment** (`payments.void`, T3, Manager+ or a manager's approval bound to that payment and its amount, reason required) reverses one recorded payment: the bill owes the amount again, an order it completed goes back to open, and when no recorded payment is left the bills unlock and pricing unfreezes. It is refused once anything has been refunded from the bill, once the payment's shift is closed and once its business day is closed; after that, a refund is the correction. A payment taken on a provider tender is voided at the provider first: the request records the void request, the worker calls the provider, and the payment is reversed when the provider confirms (`payment.voided`). While that void waits, refunds on the order, the shift's close and the business day's close are refused. A void and a shift or business-day close lock the same rows, so they run one after the other. Reopening an order paid on a provider tender is refused, because a reopen reverses payments in the register only. An agent's void is a proposal.

## Worker

`node dist/index.js --role=worker` (`src/worker/index.ts`) runs scheduled pricing-rule activation, queued CSV imports (`services/importer.ts`, contract in [csv-mapping.md](csv-mapping.md)), stale print-claim re-queue, relay heartbeat alerts, guest-session expiry and rate-limit pruning, proposal expiry, and payments: the provider outbox (every second), polling waiting intents and expiring old ones (every 5 s), and pruning webhook event ids after a day. Reports read plain SQL views (`report_*`, `security_invoker`), so RLS applies to them too. Gross sales are items as charged (tax included in inclusive mode); net sales are items after discounts, without tax and fees, less the refunds' net, and every report uses that one definition (`report_net_sales`).

## Not built

These are deliberate gaps, not hidden features. The [roadmap](roadmap.md) says which are planned.

- **Real payment providers and online payments.** The provider seam, intents, webhooks and the simulator are built; no adapter for a real provider ships, and nothing takes a payment online or on the guest's phone. A refund of a terminal payment is recorded in the register and given back on the terminal by hand.
- **Offline mode.** Every action needs the API. Queued print jobs survive a relay or printer outage.
- **Changesets.** Configuration is edited directly through the API and back-office forms; there is no draft, diff, simulate and approve flow. The back-office Changes page is a placeholder.
- **Agent runner.** Sail exposes agents to the register but ships no agents, playbooks, sandbox or evals. The back-office Assistants page is a placeholder; identities are managed through the API.
