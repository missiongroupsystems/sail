# Sail as an agent-centric POS: architecture vision

Status: draft vision for discussion, 29 Oct 2026. It builds on `docs/sail-v0.9-scope.md` (the scope doc) and does not reopen any of its decisions. Milestone detail lives in `docs/roadmap.md`. Section 13 lists what this vision would change there.

**Phil's idea.** Modern POS and restaurant SaaS have become bloated. Every merchant's workflow ends up as another screen, another toggle or another rule type in the product, and the product grows without limit. Sail goes back to first principles: **a cash register and a cashier pressing its buttons.**
- **The register** is a small, deterministic core. It exposes a minimal, complete set of primitive operations as typed API endpoints: open a bill, add a line, apply a rule, take a payment, refund, fire to the kitchen, update an order's status, and so on. An MCP server exposes the same operations to AI agents.
- **The cashier** is an AI agent. It plays the cashier, the manager or the admin. It holds the workflow, the judgement and the edge cases, and it presses the register's buttons.
- Business complexity moves **out of the core and into the agent layer**.

**Guardrails (agreed):**
1. The register still does **all money math and all state transitions**, deterministically: the pricing rules engine, GST, splits, rounding and the audit/event log. Agents never compute totals.
2. Agents and humans press **the same buttons**, with **the same permissions** and the same manager overrides.
3. A **thin, fast tablet UI** stays, for humans during the rush.

Stack, unchanged from the scope doc: Hono + Drizzle + `@hono/zod-openapi` on Fly.io (`sin`), Next.js on Vercel, Supabase Postgres (Auth and Storage only), SSE fed by `pg_notify`, and Launchpad's request and RLS pipeline.

## 1. What is actually new

The scope doc already makes the API the owner of all business logic (section 7.1, rule 1), with an OpenAPI contract, idempotency keys, an event log and a pure pricing function. That is most of a register already. This vision adds three things:

1. **The primitives are designed for an operator that is not a human.** Every operation is small, self-describing and complete. Every mutation has a dry run. Every error is typed and says what would fix it. Permissions, risk and confirmation rules are data in one operation manifest (section 4.3), which the API, the POS buttons, the MCP tool list and the docs all read.
2. **Agents are first-class principals.** An agent has an identity, a role, an outlet scope and a risk ceiling, like a staff member. Every agent action is attributed in the event log. Risky actions become **proposals** that a human approves with a PIN, and the register then executes exactly what was approved.
3. **Workflow ships as playbooks and evals, not as core code.** A new "how we do things here" request becomes a versioned playbook, tested against a simulator, instead of a new screen, toggle or rule type.

The bet: as merchants and outlets are added, the core stays roughly the size it is at v1.0, and the variety lives in playbooks.

## 2. Design principles

1. **The register is the only writer of money and state.** Totals, tax, allocations, rounding, balances, document numbers and state transitions are computed only by the register. An agent reads amounts from tool results; it never derives, adds up or restates an amount the register did not return. Any amount a human is asked to confirm is rendered from register data, never from model text.
2. **Small, complete, orthogonal primitives.** Each operation does one thing and keeps every invariant on its own. Composite workflows (close a table, handle a complaint, end the day) are sequences of primitives, not new endpoints. "Complete" means anything a merchant does on a shift can be expressed as a sequence of primitives, without a database console.
3. **One set of buttons.** The POS UI, the back office, the print relay, the guest app, our agents and any third-party MCP client call the same `/v1` operations. No client gets an endpoint or behaviour that is not in the OpenAPI spec (scope doc section 10.2, condition 2).
4. **Same permissions for everyone.** An agent is assigned one of the five fixed roles, like a person. It gets no agent super-role and no bypass. Manager overrides work the same way for agents as for people. Any principal, human or agent, can also carry a **risk ceiling** (section 7.5). For agents the default ceiling is lower than their role.
5. **Mechanism in the core, policy in the agent.** The core holds what must be deterministic and auditable: money, tax, invariants, state machines, permissions. Bounded, data-driven policy that changes money (pricing rules) stays in the core as configuration. Workflow, judgement, sequencing and interpretation live in agents.
6. **Deterministic by construction.** Pricing, allocation and refund reversal are pure functions with explicit inputs and no clock reads (scope doc rule 10). The same inputs always give the same cents.
7. **Everything is an event.** Every state change emits an event with its actor, its approver and its cause, in the same transaction. The event log is the audit trail, the sync source, the simulator's input and the eval ground truth.
8. **Agents propose, the register disposes.** An agent can ask for anything its role allows. The register decides whether the action executes now, needs a human confirmation, or is refused.
9. **The register works with no agent.** No service workflow depends on a model. If every model is down, staff press the same buttons on the tablet and nothing is lost (section 10). An agent is never on the critical path of a tap during the rush.
10. **Dry-run everything.** Every mutation accepts `dry_run: true`. It returns the resulting state, totals and events without committing. Agents plan with dry runs; humans confirm what a dry run showed.
11. **Errors are instructions.** Errors carry a stable code, the invariant or permission involved, and a remedy, for example "needs Manager+, override allowed" or "check 2 is locked by a payment; refund it first".
12. **Less configuration.** Before a new setting or rule type is added to the core, ask whether a playbook could do it with the existing primitives (section 3.4).

## 3. The register core and its boundaries

### 3.1 Shape

```
  humans (rush hour)        agents (workflow, judgement)       devices / guests
  ┌──────────────┐   ┌────────────────────────────────────┐   ┌───────────────┐
  │ POS tablet UI│   │ agent runner (our agents)          │   │ print relay   │
  │ back office  │   │ third-party MCP clients            │   │ guest web app │
  └──────┬───────┘   └──────────────┬─────────────────────┘   └──────┬────────┘
         │                          │ MCP (Streamable HTTP)          │
         │                   ┌──────▼───────┐                        │
         │                   │  MCP adapter │  generated from the    │
         │                   │  (no logic)  │  OpenAPI spec+manifest │
         │                   └──────┬───────┘                        │
         ▼                          ▼                                ▼
  ┌──────────────────────────── /v1 API (Hono, zod-openapi) ─────────────────────┐
  │ auth → principal + role + ceiling → RLS txn (admission gate) → operation     │
  │ ┌──────────────────────────── REGISTER CORE ───────────────────────────────┐ │
  │ │ operation manifest   state machines   invariants   permission matrix     │ │
  │ │ pricing pipeline (pure) · allocation · refund reversal · GST · rounding  │ │
  │ │ override grants · proposals · document sequences · stock caps            │ │
  │ │ print routing + durable job queue · event log (per-outlet sequence)      │ │
  │ └──────────────────────────────────────────────────────────────────────────┘ │
  └───────────────────────────────┬──────────────────────────────────────────────┘
                                  ▼
                     Supabase Postgres (RLS, triggers, pg_notify → SSE)
```

### 3.2 Inside the core

| Concern | In the core because |
|-|-|
| Entities and their state machines (orders, lines, checks, payments, refunds, shifts, print jobs, guest rounds, service requests, overrides, proposals, changesets) | They are the register's state. Section 6. |
| The pricing pipeline, split allocation, refund reversal, GST, cash rounding | Money math. One pure function in `shared` (scope doc section 4.8). |
| Pricing rules, menus, prices, availability, printers, tender types and other configuration | Data the deterministic code evaluates. Agents can author it, but only through changesets (section 5.13). |
| Permission matrix, overrides, proposals, risk ceilings | Who may press which button. |
| Invariants: checks add up to the order, refunds never exceed what was paid, gap-free document numbers, stock caps, one open order per table | Must hold whoever presses the buttons. Enforced in the database where possible (scope doc section 6). |
| Print routing and the durable job queue | A ticket must never be lost, and routing is deterministic from tags. |
| Deterministic detectors (void rate, cash variance, late print jobs, refunds after close) | Alerts must fire with no model available (section 8.5). |
| Event log, idempotency, optimistic concurrency, dry run | The contract that makes it safe for anything to press the buttons. |

### 3.3 Outside the core

| Concern | Who holds it |
|-|-|
| Interpreting intent ("table 12, two laksa, no chilli on one, fire the mains") | Cashier agent, or a human tapping |
| Sequencing a workflow (close the table, end the day, open the outlet) | Agent with a playbook, or a human following training |
| Judgement under ambiguity (which comp fits this complaint, whether to reroute or wait for the printer) | Manager agent proposes; a human approves when the register requires it |
| Mapping messy input (legacy CSV columns, an aggregator's order slip, an emailed catering order) into primitives | Admin or cashier agent |
| Explaining numbers (why did Tuesday's net sales drop?) | Reporting analyst |
| Noticing and explaining anomalies | Anomaly watcher, on top of the core's deterministic detectors |
| Merchant-specific "how we do things here" | Playbooks (section 9.2) |

### 3.4 Triage rule for new requirements

Every new requirement goes through three questions, in order:
1. **Does it change money math, tax, a state transition or an invariant?** It goes in the core, as a new primitive, a new rule type or a new condition type. This needs a decision, as the scope doc requires for anything outside section 4.8.
2. **Is it a tap that must be fast during the rush?** It becomes a button in the thin UI, calling existing primitives.
3. **Otherwise** it becomes a playbook, a read-only report or an agent task that composes existing primitives. The core does not change.

Some deferred items from the scope doc (section 5), triaged:

| Deferred item | Triage | Notes |
|-|-|-|
| Time-of-day rule conditions (happy hour) | Core | A new condition type in the pipeline. Agents cannot fake this safely by toggling rules. |
| Merge and split tables | Core | Two new primitives (section 5.2). |
| KDS | Core plus UI | New primitives for bump and recall (section 5.8). |
| Delivery-app orders keyed in by hand | Agent | The cashier agent reads the aggregator's order slip and keys it in with existing primitives and the aggregator tender. Integration stays deferred. |
| Scheduled report delivery | Agent | Reporting analyst on a schedule. |
| AI chat on reports | Agent | Reporting analyst. Pulled forward to v0.9 (section 13). |
| Terminal settlement reconciliation | Agent | Manager agent compares the Z-report card total with the terminal's total, from a photo or export, and flags differences. Sail still never talks to the terminal. |
| Allergen and nutri-grade questions | Agent, reading catalogue data | The data is configuration in the core. Answering questions about it is agent work. |
| Loyalty, drip campaigns, segments | Mostly agent, plus small core pieces | Points or stored value would be core money and need a decision. Messaging and segments are agent work over customer data with consent. |
| Promo codes and usage limits | Core | They change money math, so they are rule-engine work. |

## 4. Operation conventions

### 4.1 Naming

Each operation has one ID of the form `group.verb`. It maps to one REST route and one MCP tool:

| Operation ID | REST | MCP tool |
|-|-|-|
| `orders.open` | `POST /v1/orders` | `orders_open` |
| `lines.add` | `POST /v1/orders/{order_id}/lines` | `lines_add` |
| `payments.record` | `POST /v1/checks/{check_id}/payments` | `payments_record` |

The operation ID is the OpenAPI `operationId`.

### 4.2 Common envelope

**Every mutation accepts:**
- `Idempotency-Key` (header). Required. Over MCP it is a required `idempotency_key` argument.
- **Client-generated UUIDs** for anything it creates: `order_id`, `line_id`, `check_id`, `payment_id`, `refund_id` (scope doc rule 3). A repeated call with the same ID and the same payload replays the stored result. The same ID with a different payload returns `idempotency_conflict`.
- `expected_version` (or `If-Match`) for the order or resource it changes. A mismatch returns `version_conflict` with the current state, so the caller can plan again.
- `dry_run` (default false).
- `override_id`: a single-use override grant (scope doc rule 9).
- `proposal_id`: when executing an approved proposal (section 7.4).
- `reason_id` and `reason_text`, when the operation or rule requires a reason.

**Every mutation returns:**
- The changed resource and its new `version`.
- The events it emitted, with their sequence numbers (in a dry run, the events it **would** emit, with no sequence numbers).
- For anything that touches an order: a **priced order snapshot** with lines, adjustments, checks, totals, balances and pricing status (`live` or `frozen`). This is how agents learn amounts without computing them.
- `warnings`, for example "this product routes to no printer".

**Errors** share one shape: `{ code, message, remedy, details }`.

| Code | Meaning | Example remedy |
|-|-|-|
| `validation` | Input fails the schema | The failing field and the rule |
| `not_found` | Resource is missing or outside the caller's scope | |
| `version_conflict` | Someone else changed it | Current snapshot attached |
| `idempotency_conflict` | Key or ID reused with a different payload | Use a new key |
| `permission_denied` | Role too low | `required_role`, `override_allowed` |
| `requires_confirmation` | Above the caller's risk ceiling | `proposal_id` to show a human (section 7.4) |
| `invariant_violation` | Would break an invariant | Invariant name, for example `check_locked_by_payment` |
| `state_conflict` | Wrong state for this transition | Allowed transitions from the current state |
| `unavailable` | 86'd, capped out or outside the availability window | Remaining cap, when it restocks |
| `rate_limited`, `budget_exceeded` | Limits on the principal (section 11) | When to retry |

### 4.3 The operation manifest

Each operation's route carries an `x-sail` extension in the OpenAPI spec:

```yaml
x-sail:
  op: refunds.create
  tier: T3                  # risk tier, section 7.3
  min_role: manager         # from the fixed permission matrix
  override_allowed: true
  reason_required: true
  dry_run: true
  emits: [refund.created, check.refunded, print_job.created]
  mcp:
    expose: true
    toolsets: [pos.refund]
```

The manifest is the **single source** for:
- API enforcement (one middleware reads it, so no route checks roles by hand),
- which buttons the POS shows or greys out,
- `tools/list` on the MCP server,
- the permission column in this catalogue and in the generated docs.

CI fails if a route has no manifest entry, and the spec diff check (scope doc condition 2) covers manifest changes too. Some rules depend on data, for example a manual pricing rule's own `min_role` (scope doc section 4.8). The manifest names the data source, and the same middleware evaluates it.

## 5. Primitive catalogue through v1.0

Permissions use the scope doc's roles: Server < Cashier < Manager; Finance and Admin are separate (Finance manages past orders; Admin edits configuration). "X+" means role X or above. Permissions the scope doc fixes are marked **(scope)**; the rest are proposals for the fixed matrix and need confirmation. Tiers (T0 to T3) are defined in section 7.3. Each table lists the operations that matter for the design; pagination, list filters and other plumbing are left out.

Unless a row says otherwise, every mutation keeps these invariants: the change is in scope for the caller's merchant and outlet (RLS); the caller's version matches; and the change and its events commit together.

### 5.1 Sessions, principals and approvals

| Operation | Inputs | Output | Invariants | Permission | Tier | Since |
|-|-|-|-|-|-|-|
| `stations.pair` | one-time pairing code, device label | station token | Code is single-use and short-lived. One station per token. | Admin issues the code | T3 | v0.9 |
| `staff_sessions.start` | station token, PIN | PIN session | Staff member is scoped to the station's outlet and brand. Lockout after repeated failures. | Any staff | n/a | v0.9 |
| `staff_sessions.end` | session | | Inactivity expiry is enforced on the server too | Self | T1 | v0.9 |
| `overrides.grant` | action op ID, target ID, approver PIN, requester | single-use grant | Approver role ≥ the action's `min_role`. The grant is bound to that action and target, used once, and expires. **(scope)** | Manager+ approver | n/a | v0.9 |
| `agent_sessions.start` | agent identity credential; optional `on_behalf_of` (a PIN session or back-office user) | agent token (short-lived) | Effective role is the lower of the agent's role and the human's role (section 7.2). Outlet scope is the intersection. | Admin provisions the identity | n/a | v0.9 |
| `proposals.get` / `proposals.list` | outlet, status | proposals with frozen request and register quote | | Same role as the proposed operation | T0 | v0.9 |
| `proposals.approve` | proposal ID, approver PIN or back-office session | executed result, or `version_conflict` | Approver's role ≥ the operation's `min_role`. The approver cannot be the proposing principal. Executes the frozen request exactly. Expires. | As the operation | n/a | v0.9 |
| `proposals.reject` | proposal ID, reason | | | Any approver-level role | T1 | v0.9 |
| `relays.pair` | pairing code | relay token | As `stations.pair` | Admin | T3 | v0.9 |
| `relays.heartbeat` | relay token, version | | | Relay only, not in MCP | n/a | v0.9 |

### 5.2 Order lifecycle

| Operation | Inputs | Output | Invariants | Permission | Tier | Since |
|-|-|-|-|-|-|-|
| `orders.open` | `order_id`, outlet, brand, channel, `order_type`; type-specific fields (table and pax; name; customer reference and ready-by; address and delivery notes) | priced order snapshot | Required fields per order type (scope doc 4.3). At most one open dine-in order per table. Order number from the per-outlet sequence with a source prefix. | Server+ | T1 | v0.9 |
| `orders.update_details` | pax, customer reference, ready-by, address, notes | snapshot | Fields valid for the order type | Server+ | T1 | v0.9 |
| `orders.change_type` | new `order_type` and its fields | snapshot, re-priced | **Blocked after the first payment** (scope doc section 6) | Server+ | T1 | v0.9 |
| `orders.attach_customer` / `orders.detach_customer` | `customer_id` | snapshot, re-priced | Group conditions re-evaluate. Frozen order-level results stay frozen. | Server+ | T1 | v0.9 |
| `orders.move_table` | target table | snapshot | Target has no open order. Seats and guest sessions follow the order. | Server+ | T1 | v0.9 |
| `orders.fire` | `line_ids` (default: all unfired, unheld lines) | fired lines, print jobs created | One print job per target printer, **in the same transaction** (scope doc 4.7). On a "pay before firing" station, blocked until the balance is 0. Lines already fired are ignored. | Server+ | T2 | v0.9 |
| `orders.mark_ready` | | snapshot | Order is fired | Server+ (Kitchen in v1.0) | T1 | v0.9 |
| `orders.mark_out_for_delivery` | optional rider note | snapshot | `delivery` orders only, from `ready` | Server+ | T1 | v0.9 |
| `orders.complete` | | snapshot | Every check paid (balance 0). Every line fired or voided. | Server+ | T2 | v0.9 |
| `orders.cancel` | reason | snapshot | No payments. Fired lines must be voided first, which needs Manager+. | Server+ | T2 | v0.9 |
| `orders.reopen` | reason | snapshot; payments reversed | Same business day. Reverses that order's payments as events, then the order is recharged. **(scope)** | Manager+ **(scope)** | T3 | v0.9 |
| `orders.merge` | source order IDs, target order ID | target snapshot, sources closed as merged | No payments on any of them. Lines keep their fired state and seats. Re-priced. | Server+ | T2 | v1.0 |
| `orders.transfer_lines` | source order, target order or new table, `line_ids` and quantities | both snapshots | No payments on the source lines' checks. Both orders re-priced in one transaction. | Server+ | T2 | v1.0 |

### 5.3 Lines

| Operation | Inputs | Output | Invariants | Permission | Tier | Since |
|-|-|-|-|-|-|-|
| `lines.add` | array of `{line_id, product_id, qty, modifiers (nested, max 2 levels), notes, seat_no, hold, open_price}`; all-or-nothing | snapshot | Product is on the channel's menu and available at this outlet and time. Not 86'd. The daily cap is checked and decremented. Modifier min/max and per-modifier max quantity. Open price only on open-price items. | Server+; open price Manager+ **(scope)** | T1 | v0.9 |
| `lines.update` | `line_id`; qty, notes, seat, modifiers, hold | snapshot | **Unfired lines only.** Cap re-checked on a quantity increase. | Server+ | T1 | v0.9 |
| `lines.void` | `line_id`, qty, `reason_id` | snapshot; void ticket job if fired | Reason required **(scope)**. Not on a line whose check has a payment (refund instead). A void before firing releases its cap. A void after firing prints a void ticket to the printers that got the item. | Unfired: Server+. Fired: Manager+ or override **(scope)** | T1 unfired, T3 fired | v0.9 |

### 5.4 Pricing

| Operation | Inputs | Output | Invariants | Permission | Tier | Since |
|-|-|-|-|-|-|-|
| `orders.quote` | order ID, optional hypothetical changes | priced snapshot with the full pipeline trace (each step and rule) | Pure: the same function as the server and the simulator. Writes nothing. | Anyone who can read the order | T0 | v0.9 |
| `adjustments.apply_manual` | rule ID, `entered_value` (open rules), `line_ids` (item-scoped rules), reason | snapshot with the new adjustment | The value is inside the rule's open min/max. Rule conditions hold. Stacking and cap respected. The rule's own `min_role`, `override_allowed` and `reason_required` apply **(scope)**. | Per rule | T2 within role; T3 if an override is needed | v0.9 |
| `adjustments.remove` | adjustment ID, reason | snapshot | Manual adjustments only. Blocked if the adjustment is frozen by a payment. | The role that could apply it | T2 | v0.9 |
| `pricing.simulate` | sample basket, outlet, order type, customer group, rule set (current, a version, or a changeset) | full pipeline trace | Pure | Manager+, and agents with the admin or analyst toolset | T0 | v0.9 |

Automatic rules have no "apply" button. The register re-runs the pipeline whenever an open order changes (scope doc 4.8), so an agent cannot forget, or choose not, to apply an automatic rule.

### 5.5 Checks, bills and documents

| Operation | Inputs | Output | Invariants | Permission | Tier | Since |
|-|-|-|-|-|-|-|
| `checks.split_even` | N | snapshot with N checks | **Checks add up to the order to the cent** (largest remainder, check order breaks ties) **(scope)**. Allowed only before the first payment. | Server+ | T1 | v0.9 |
| `checks.split_by_seat` | how to treat shared lines (`even` or `manual`) | snapshot | As above. One check per seat. | Server+ | T1 | v0.9 |
| `checks.allocate` | moves `{line_id, from_check, to_check, share_num, share_den}` | snapshot | As above. Equal shares only in v0.9. A paid check's allocations are locked. | Server+ | T1 | v0.9 |
| `checks.unsplit` | | snapshot, one check | No payments yet | Server+ | T1 | v0.9 |
| `checks.print_prebill` | check ID or whole order | print job | | Server+ | T1 | v0.9 |
| `documents.issue_invoice` | check ID | invoice number, PDF | Check is paid. Gap-free number per merchant. Issued once; reprints reuse the number. | Cashier+ | T2 | v0.9 |
| `receipts.print` | check ID or refund ID | print job | | Server+ | T1 | v0.9 |
| `receipts.send` | check ID or refund ID; email or SMS | delivery record | Customer consent rules for the address | Cashier+ | T2 | v0.9 |

### 5.6 Payments and cash

| Operation | Inputs | Output | Invariants | Permission | Tier | Since |
|-|-|-|-|-|-|-|
| `payments.record` | `payment_id`, check ID, tender type, amount, cash tip, reference | payment with `rounding_cents`, check balance, change due | Non-cash amount ≤ balance. Cash rounding only on `is_cash` tenders that settle the balance, computed by the register **(scope)**. A check with a payment locks its allocations, and the first payment freezes order-level rules. A check at balance 0 becomes paid. | Cashier+ **(scope)** | T2 | v0.9 |
| `payments.void` | payment ID, reason | check balance | Only before the order is completed, to fix a wrong tender or amount. After completion, use `orders.reopen` or a refund. **Needs a decision**: the scope doc lists the wrong-tender risk but no void operation. | Manager+ or override | T3 | v0.9 (proposed) |
| `payment_intents.create` | check ID, amount | dynamic PayNow QR payload, intent ID | The amount is the register's balance. A provider webhook (register-internal, not a button) records the payment. | Cashier+ | T2 | v1.0 |
| `payment_intents.cancel` | intent ID | | Not yet confirmed | Cashier+ | T1 | v1.0 |
| `shifts.open` | station or outlet, counted float | shift | One open shift per station | Cashier+ | T2 | v0.9 |
| `shifts.close` | counted cash | expected cash, variance | Expected cash comes from `is_cash` tenders, refunds and rounding **(scope)** | Cashier+; Manager+ to close another person's shift | T2 | v0.9 |
| `business_days.close` | outlet, business date | Z-report snapshot | Every shift for that day is closed. Uses the business-day cutoff. Immutable after close (later refunds count on their own day **(scope)**). | Manager+ | T2 | v0.9 |

### 5.7 Refunds

| Operation | Inputs | Output | Invariants | Permission | Tier | Since |
|-|-|-|-|-|-|-|
| `refunds.quote` | check ID; `kind` (`full`, `lines`, `amount`); lines and quantities or amount; tender split | reversal per line, per adjustment and for GST; per-tender caps; cash rounding | Pure; writes nothing. The same allocation code as splits **(scope)**. | Anyone who can read the order | T0 | v0.9 |
| `refunds.create` | `refund_id`, as quote, plus `reason` | refund, refund receipt number, credit note number if the check was invoiced, print job | Each line's refunds ≤ its paid amount. Each payment's refunds ≤ what it paid. Dated by business day. Gap-free document numbers. Caps do not restore stock **(scope)**. | Manager, Finance or Admin, or override **(scope)** | T3 | v0.9 |

### 5.8 Kitchen and printing

| Operation | Inputs | Output | Invariants | Permission | Tier | Since |
|-|-|-|-|-|-|-|
| `print_jobs.reprint` | job ID | new job marked `reprint_of` | | Server+ | T1 | v0.9 |
| `print_jobs.reroute` | job IDs, target printer (default: the configured backup) | new jobs; originals marked rerouted | The target has the right role (kitchen or receipt). Not already printed. | Server+ | T1 | v0.9 |
| `print_jobs.test` | printer ID | job | | Admin | T1 | v0.9 |
| `print_jobs.claim` / `print_jobs.ack` | relay token; job ID; result | | Relay principal only. Not exposed over MCP. | Relay | n/a | v0.9 |
| `kds.bump` / `kds.recall` | ticket ID or line IDs | line kitchen status | Lines are fired. Bumping all of an order's lines can mark it ready (outlet setting). | Kitchen station | T1 | v1.0 |

### 5.9 Scan to Order

| Operation | Inputs | Output | Invariants | Permission | Tier | Since |
|-|-|-|-|-|-|-|
| `guest_sessions.create` | table token | guest token | The table has an open order, unless "open on first scan" is on. Rate-limited. **(scope)** | Guest | n/a | v0.9 |
| `rounds.submit` | round ID, lines (same shape as `lines.add`) | round status | Same menu, availability and cap checks as `lines.add`. **No payment of any kind** **(scope)**. Fires straight away, or waits for acceptance if "hold orders" is on. | Guest | n/a | v0.9 |
| `rounds.accept` / `rounds.reject` | round ID, reason on reject | snapshot; fired and printed on accept | Pending rounds only | Server+ | T2 | v0.9 |
| `service_requests.create` | type (one of the channel's up to 5, or call for bill) | request | Rate-limited. Call for bill changes the table status. | Guest | n/a | v0.9 |
| `service_requests.acknowledge` | request ID | | | Server+ | T1 | v0.9 |

### 5.10 Stock

| Operation | Inputs | Output | Invariants | Permission | Tier | Since |
|-|-|-|-|-|-|-|
| `stock.mark_sold_out` | product, outlet, until (`today`, a date, `indefinite`) | availability | Enforced by `lines.add` and `rounds.submit` | Cashier+ | T1 | v0.9 |
| `stock.restore` | product, outlet | availability | | Cashier+ | T1 | v0.9 |
| `stock.set_daily_cap` | product, outlet, quantity | cap and remaining | The remaining cap never goes below 0 | Manager+ | T2 | v0.9 |

### 5.11 Customers

| Operation | Inputs | Output | Invariants | Permission | Tier | Since |
|-|-|-|-|-|-|-|
| `customers.find` | mobile, or name prefix | matches; contact details **masked for agents** unless the role needs them | | Server+ | T0 | v0.9 |
| `customers.upsert` | customer ID, name, mobile, email, marketing consent | customer | Mobile unique per merchant. Consent changes are evented. | Cashier+ | T1 | v0.9 |
| `customer_groups.set_members` | group ID, adds and removes | group | Changes pricing eligibility, so it is a config change and evented | Manager+ | T3 | v0.9 |

### 5.12 Reads

All T0. Every read is scoped by RLS and returns cents and register-computed totals only.

| Operation | Returns | Since |
|-|-|-|
| `orders.get` | Priced snapshot, checks, payments, refunds, adjustments, print jobs, notes | v0.9 |
| `orders.list` | Orders by status, type, table, ready-by, date | v0.9 |
| `floor.snapshot` | Tables with live status, elapsed time, pending rounds and service requests | v0.9 |
| `events.list` | Events after a sequence number for an outlet (the scope doc's catch-up endpoint) | v0.9 |
| `menu.get` | A channel link's menu, with prices, modifiers, availability and 86 status | v0.9 |
| `catalogue.search` | Products and modifiers by name, SKU or tag | v0.9 |
| `shifts.get`, `business_days.get` | Shift and day state, expected cash, Z-report | v0.9 |
| `reports.run` | A named report (scope doc 4.10) with typed parameters | v0.9 |
| `reports.query` | A read-only query over the reporting views (section 8.4) | v0.9 |
| `audit.list` | Events filtered by actor, approver, operation or target | v0.9 |
| `print_jobs.list` | Jobs by status, printer or order | v0.9 |
| `playbooks.get` | The playbooks that apply to an outlet and role | v0.9 |

### 5.13 Configuration through changesets

Every configuration change goes through a **changeset**: a typed list of operations on configuration entities, with a computed diff. Changesets replace one bespoke editor per entity as the write path. The back office keeps simple forms, but each form saves as a one-operation changeset.

Entity operations a changeset can contain: upsert or archive a product, price per order type, modifier group, menu section, availability window, POS layout, table or area, channel link, printer, tender type, void reason, pricing rule (as a new version), customer group, staff role and scope, merchant settings.

| Operation | Inputs | Output | Invariants | Permission | Tier | Since |
|-|-|-|-|-|-|-|
| `changesets.create` | scope (merchant, brand or outlet), entity operations | draft with diff | Each entity operation validates against its zod schema | Admin; agents with the `config.author` toolset can draft | T1 (draft only) | v0.9 |
| `changesets.validate` | changeset ID | warnings: overlapping exclusive rules, tags that route to no printer, caps below the minimum, products no fee covers **(scope)**, orphaned modifiers | Pure | Admin | T0 | v0.9 |
| `changesets.simulate` | changeset ID; sample baskets or **a replay of the last N days of orders** | pipeline traces; revenue, discount and fee deltas by rule, outlet and day | Pure: the pipeline runs on stored order inputs | Admin, Finance | T0 | v0.9 |
| `changesets.approve` | changeset ID, `effective_from` | scheduled or applied | The approver is a human Admin, not the author. Pricing rules create new versions; orders keep their snapshots **(scope)**. | Admin | T3 | v0.9 |
| `changesets.revert` | applied changeset ID | a new inverse changeset, as a draft | | Admin | T3 | v0.9 |
| `imports.upload` / `imports.map` | CSV file; column mapping | a changeset | Records matched by SKU or legacy ID, so a re-run is a diff, not a duplicate **(scope)** | Admin | T1 (draft) | v0.9 |
| `tables.rotate_qr_token` | table ID | new token; old QR codes stop working | | Admin | T3 | v0.9 |

Small, urgent service changes (86, daily caps, rerouting a printer) are **not** changesets. They are primitives in sections 5.8 and 5.10, so they work during the rush with no Admin present.

### 5.14 Agent support

| Operation | Inputs | Output | Invariants | Permission | Tier | Since |
|-|-|-|-|-|-|-|
| `notes.add` | target (order, table, shift, day), text | note shown to staff | Plain text, length-limited, never parsed as an instruction by other agents (section 11) | Server+ | T1 | v0.9 |
| `alerts.raise` | severity, target, message, evidence event sequences | alert on the POS and back office | Rate-limited per principal | Agents with the `watch` toolset; Manager+ | T1 | v0.9 |
| `alerts.acknowledge` | alert ID | | | Server+ | T1 | v0.9 |

That is about 75 operations at v1.0. A new primitive needs a decision, as a new pricing condition type does today.

## 6. Event log and state model

### 6.1 State machines

Current-state tables stay authoritative, as in the scope doc. Every transition is one primitive, which writes the state change and its event in one transaction.

| Entity | States and transitions | Triggered by |
|-|-|-|
| Order | `open → fired → ready → completed`; delivery inserts `out_for_delivery` after `ready`; `open`/`fired → cancelled`; `completed → open` (reopen, same day); v1.0: `→ merged` | `orders.*` |
| Line | `pending` (or `held`) `→ fired → voided`; v1.0 kitchen status `fired → bumped` | `lines.*`, `orders.fire`, `kds.*` |
| Check | `open → paid → partially_refunded → refunded`; `locked_at` set by the first payment | `checks.*`, `payments.record`, `refunds.create` |
| Payment | `recorded → reversed` (by reopen or void) | `payments.*`, `orders.reopen` |
| Payment intent (v1.0) | `pending → confirmed` (webhook) or `cancelled`/`expired` | `payment_intents.*` |
| Refund | Immutable once created | `refunds.create` |
| Print job | `queued → claimed → printed`, or `failed`; `failed`/`queued → rerouted`; stale `claimed → queued` (worker) | Fire, receipts, relay, `print_jobs.*` |
| Guest round | `pending → accepted → fired`, or `rejected` | `rounds.*` |
| Service request | `open → acknowledged` | `service_requests.*` |
| Shift | `open → closed` | `shifts.*` |
| Business day | `open → closed` | `business_days.close` |
| Override grant | `issued → used`, or `expired` | `overrides.grant`, the protected operation |
| Proposal | `pending → approved → executed`, or `→ failed` (version conflict at execution); `pending → rejected`/`expired` | Section 7.4 |
| Changeset | `draft → approved → scheduled → applied`; `draft → discarded`; `applied →` inverse draft | `changesets.*` |

### 6.2 Event shape

The scope doc's `order_events` table (per-outlet sequence, assigned under a lock on the outlet's counter row) gains an actor block and causation fields:

```ts
type SailEvent = {
  seq: number;                 // per outlet; config events use a per-merchant sequence
  merchant_id: string; outlet_id: string | null;
  business_date: string;
  occurred_at: string;         // server clock, at commit
  type: string;                // e.g. "line.added", "payment.recorded"
  aggregate: { kind: string; id: string; version: number };
  operation_id: string;        // e.g. "lines.add"
  idempotency_key: string;
  actor: {
    principal_type: "staff" | "station" | "guest" | "relay" | "agent" | "system";
    principal_id: string;
    role: Role | null;
    on_behalf_of?: string;     // the human an agent session acts for
    agent?: { identity_id: string; session_id: string; task_id: string;
              model: string; playbook_versions: string[] };
  };
  approval?: { override_id?: string; proposal_id?: string; approver_id: string };
  reason?: { id?: string; text?: string };
  causation_id?: string;       // the event or proposal that led to this one
  correlation_id: string;      // one agent task or one UI action
  payload: unknown;            // typed per event type, zod schema in `shared`
};
```

- **Configuration has its own log** (`config_events`, per-merchant sequence), written by `changesets.approve` and the scheduled-activation worker. This lets an order's priced snapshot point to the exact configuration it saw.
- **Agent transcripts stay out of the event log.** The full model input, output and tool calls for each task are stored in `agent_traces` (Postgres metadata, with large bodies in Supabase Storage) and linked by `task_id`. The event log records what happened; the trace records why the agent did it.
- **Dry runs emit nothing.** They run the operation in the request transaction and roll it back. To avoid holding locks during a dry run, they skip sequence allocation (outlet sequence and gap-free document numbers return placeholders) and create no print jobs.
- **Retention.** Events are kept for as long as accounting records must be. Traces are kept for 90 days by default, then summarised (open question 6).

### 6.3 What the log is used for

| Use | How |
|-|-|
| Audit trail | Who did what, who approved it, on whose behalf, with which playbook version |
| Live updates and catch-up | Unchanged from the scope doc (section 7.1, rule 7) |
| Agent triggers | The agent runner follows each outlet's stream with a stored cursor, like a POS station (section 8.5) |
| Simulator input | Replays real days, with anonymised customers, into a sandbox register (section 9.3) |
| Eval ground truth | What staff actually did, as reference traces |
| Offline sync later (v1.1/1.2) | Unchanged: client UUIDs and idempotency keys make replay safe |

## 7. MCP server design

### 7.1 Placement and generation

- **Process.** The MCP adapter runs from the same server image with `--role=mcp`, as its own Fly process group (`mcp`) next to `app` and `worker`. It uses the official MCP TypeScript SDK with the Streamable HTTP transport, in stateless mode, at `https://mcp.<domain>/`.
- **Generated, with no logic.** A build step reads the OpenAPI spec and the `x-sail` manifest and writes the tool manifest: tool name, description, JSON schema (from the same zod schemas), tier and toolsets. The manifest is committed, and CI checks it like the spec.
- **Every tool call is an API request.** The adapter calls the Hono app in-process (`app.request`) with the agent's bearer token. Each call therefore goes through the same auth, the same RLS transaction, the same admission gate, idempotency and manifest checks as a POS tap. There is no second code path to keep in sync.
- **Descriptions are written for models.** Each route's OpenAPI description says when to use it, what it never does (for example, "never computes totals; read `snapshot.totals`"), and links to related tools. These descriptions are part of the reviewed spec.
- **Resources and prompts.** Playbooks are exposed as MCP resources (`sail://playbooks/{scope}/{name}`) and as prompts for the common workflows. The menu and the floor are resources as well as tools, so clients can cache them.

### 7.2 Auth and identity

- **Agent identities** (`agent_identities` table): merchant, name, role (one of the five), outlet and brand scope, toolsets, risk ceiling, daily budgets (section 11), enabled flag. Admin creates them in the back office. Creating or widening one is a T3 change.
- **Our own agents** get a token from `agent_sessions.start`, using a credential held by the agent runner. Tokens last 15 minutes and are bound to a task.
- **Third-party MCP clients** (for example an operator's own desktop assistant) use MCP's OAuth 2.1 flow. The authorization step is a normal back-office login through Supabase Auth, so the session always acts **on behalf of that person**.
- **On behalf of.** When an agent acts for a signed-in human, such as the cashier at a station using the assistant, its effective role is the **lower** of the agent identity's role and the human's role, and its scope is the intersection. An agent can never do something for a Server that the Server could not do (no confused deputy).
- **RLS.** The pipeline sets `app.current_principal_type = 'agent'` and runs `SET LOCAL ROLE app_agent`. `app_agent` is a new narrow role, like `app_guest` and `app_relay`. It has no grants on token tables, PIN hashes or raw customer contact columns (it reads masked views), and it cannot write to the configuration tables directly.

### 7.3 Risk tiers

| Tier | Meaning | Examples | Agent at an attended station | Unattended agent |
|-|-|-|-|-|
| T0 | Read, quote, dry run | `orders.get`, `refunds.quote`, `changesets.simulate` | Runs | Runs |
| T1 | Routine and reversible before anything leaves the register | `lines.add`, `checks.split_even`, `stock.mark_sold_out`, `print_jobs.reroute` | Runs, with undo shown | Runs if the toolset allows |
| T2 | Consequential: food leaves the kitchen, money is recorded, an order closes | `orders.fire`, `payments.record`, `adjustments.apply_manual` within role, `shifts.close` | Runs after the human taps confirm on a register-rendered summary | Proposal |
| T3 | Restricted: Manager+ money-out, overrides, configuration, identities | `refunds.create`, `lines.void` after firing, `orders.reopen`, `changesets.approve` | **Always a proposal** | **Always a proposal** |

The ceiling is a property of the **identity**, not of being an agent. Human identities can have one too, for example a trainee capped at T1. The defaults: humans have no ceiling beyond their role; agents are capped at T1 when unattended and at T2 when attended. **No agent identity can reach T3 in v1.0**: money going out, overrides and configuration always need a human key. This is what "same buttons, same permissions" means in practice: the agent reaches the same button through the same permission check, and the human holds the second key for the dangerous ones.

### 7.4 Proposals

When an operation is above the caller's ceiling, or needs an override the caller cannot grant, the register does not refuse outright. It returns `requires_confirmation` and stores a **proposal**:

1. **Freeze.** The proposal holds the exact operation, arguments, `expected_version` and idempotency key, plus a **register-computed quote** of its effect (for a refund, the `refunds.quote` result: amounts per line and per tender).
2. **Show.** The proposal appears on the outlet's POS (as a notification, like a service request) and in the back office, with the agent's rationale from `notes`. The amounts on the card come from the quote, never from model text.
3. **Approve.** A human with the required role approves with a PIN or a back-office session. The register issues an override grant bound to that proposal and **executes the frozen request**. The agent cannot change the arguments after approval.
4. **Outcome.** If the order changed in the meantime, execution fails with `version_conflict` and the proposal is marked `failed`. The agent must propose again from the new state. Proposals expire after 10 minutes during service, or 24 hours for configuration.

The proposing agent gets the outcome on its task (section 8). Rejections, with their reasons, become eval cases (section 9.4).

### 7.5 Idempotency and concurrency for agents

- Models retry and repeat themselves. Every mutating tool therefore **requires** `idempotency_key` and the client-generated resource IDs. The agent runner generates them per planned step, records them in the trace, and reuses them when it retries a step. "Two more Cokes" said twice therefore makes two `lines.add` calls with different line IDs, while a network retry of one call reuses its ID.
- Agents must pass `expected_version` on order mutations. On `version_conflict` they get the fresh snapshot and plan again, as a second station would.
- **Batching is a primitive, not a workflow.** `lines.add` takes an array and is all-or-nothing, so a five-item order never half-lands. Multi-step plans (add lines, then split, then fire) can stop part-way, but the register is valid after every step, and the runner records which steps committed.

### 7.6 Toolsets

`tools/list` returns only the tools in the identity's toolsets, filtered by its role and ceiling. A Server-level cashier agent never sees `refunds.create`; it can still ask for a refund through `proposals` if a playbook says so.

| Toolset | Tools |
|-|-|
| `pos.read` | Reads in 5.12, `orders.quote`, `menu.get`, `floor.snapshot` |
| `pos.order` | 5.2 to 5.5 (except T3), `notes.add` |
| `pos.payment` | `payments.record`, `documents.issue_invoice`, `receipts.*` |
| `pos.refund` | `refunds.quote`, `refunds.create` (proposal only for agents) |
| `kitchen` | `orders.fire`, `orders.mark_ready`, `print_jobs.*`, `stock.*`, v1.0 `kds.*` |
| `guest` | Scan to Order operations only, under a guest token (section 8.6) |
| `config.author` | `changesets.create`, `validate`, `simulate`, `imports.*`, `pricing.simulate` |
| `reports` | `reports.run`, `reports.query`, `audit.list` |
| `watch` | `events.list`, `alerts.raise`, `alerts.acknowledge`, reads |

## 8. Agent roles

Our agents run in an **agent runner**: a Node service in the monorepo (package `agents`), run as a Fly process group (`--role=agents`). It calls the register only through the MCP server, the same way a third-party client does. Each unit of work is an **agent task** (`agent_tasks` table: trigger, identity, status `queued → running → succeeded | failed | needs_human | cancelled`, budget, cost, trace). Model choice is configuration per role: a fast, cheap tier for parsing and triage, and a stronger tier for authoring and analysis.

| Role | Purpose | Identity role and ceiling | Toolsets | Triggers | Since |
|-|-|-|-|-|-|
| Cashier assistant | Turns staff intent into primitives; keys in phone, catering and aggregator orders | Server or Cashier, **on behalf of** the signed-in human; T2 attended | `pos.read`, `pos.order`, `pos.payment` | Assistant panel on the POS (text, then voice) | v0.9 pilot, v1.0 |
| Manager agent | Handles exceptions during service and runs the open and close checklists | Manager; T1 unattended, T2 attended; money-out by proposal | `pos.*`, `kitchen`, `watch` | Alerts, schedule, POS panel | v0.9 (proposals), v1.0 |
| Admin / config author | Menu changes, pricing-rule drafts, CSV import mapping, layouts | Admin; **drafts only** | `config.author`, `pos.read`, `reports` | Back-office chat, uploaded files | v0.9 |
| Reporting analyst | Answers questions about sales, mix, voids and refunds; scheduled summaries | Finance, read-only | `reports`, `pos.read` | Back-office chat, schedule | v0.9 |
| Anomaly watcher | Triages the core's deterministic detectors, explains them, notifies the right person | Manager, read plus alerts only | `watch`, `reports` | Event stream | v0.9 |
| Guest ordering (chat, voice) | Takes orders from guests | **Guest token**, not a staff role | `guest` | Guest web app chat, phone line | v1.x |

### 8.1 Cashier assistant

- **Loop:** parse the intent, then `menu.get` and `catalogue.search` to resolve items and modifiers, then a dry run of `lines.add`. The POS shows the **register-priced** pending lines as a diff. Staff tap confirm, or edit by hand. T1 steps can commit directly with an undo; T2 steps (fire, payment) need the tap.
- **Where it helps:** long or unusual orders, orders read off a phone call or an aggregator slip (a photo of the slip), "split the wine three ways and the rest by seat", and finding an item in a 20,000-item catalogue.
- **Where it does not:** a regular order during the rush. Tapping tiles is faster than any model turn. The assistant is optional on every screen.

### 8.2 Manager agent

- **During service:** when a print job is late, it checks relay heartbeats and the printer's backup, then reroutes (T1) and tells the station. For a complaint, it reads the order, applies the playbook ("late main: comp the dish up to $X"), runs `refunds.quote` or a dry run of `adjustments.apply_manual`, and raises a proposal for the duty manager.
- **Open and close:** runs the checklist in the playbook. At close: open orders, unacknowledged requests, unprinted jobs, shifts not closed. It reads the Z-report, compares the card total with the terminal's end-of-day total (from a photo or export the manager provides) and writes the result as a note on the business day. It never closes a shift or day itself unless attended.

### 8.3 Admin / config author

- **Legacy import (a v0.9 beta blocker).** The agent reads the legacy CSV exports, proposes the column mapping, runs `imports.map` to get a changeset, and runs `changesets.validate`. It fixes what it can as further drafts, and lists what needs a human. An Admin reviews the diff and approves. Re-runs produce small diffs, because records match on SKU or legacy ID.
- **Pricing rules.** "Add a 15% staff meal for one outlet's team only, Cashier+, reason required" becomes a draft rule version. The agent then runs `changesets.simulate` against a replay of the last 14 days and reports the expected discount cost by outlet. An Admin approves with an effective time.
- **Bulk edits.** "Raise all coffee by 20 cents at the airport outlets from Monday" becomes one changeset with a reviewable diff.

### 8.4 Reporting analyst

- Uses `reports.run` for the named reports, and `reports.query` for anything else.
- `reports.query` takes a **typed query** over a semantic layer: the reporting views from scope doc 4.10, with declared dimensions and measures. It is not raw SQL. It runs under a read-only role with a statement timeout, on the worker, outside the request admission gate, so analysis can never slow down a till.
- Every number in an answer cites the query that produced it. The UI renders the numbers from the query result, and the model writes the narrative around them.

### 8.5 Anomaly watcher

- **Detection is deterministic and in the core**: void rate per staff member, refunds after close, discounts near caps, cash variance over a threshold, print jobs late or failed, relays missing heartbeats, rounds pending too long. Each detector raises a signal event.
- **The watcher triages:** it groups related signals, looks up context (who was on shift, which printer), writes a short explanation, decides who to notify, and raises an alert. It never acts on orders.
- Without the model, the core's signals still notify, without the explanation (section 10).

### 8.6 Guest ordering (v1.x)

- Runs under a **guest token**. It can do exactly what Scan to Order can, and nothing more: browse the menu, submit rounds, and send service requests. It can never take or request payment (scope doc 4.6), see other tables, or apply discounts.
- A phone or chat pickup order would need a new channel (for example `agent_pickup`) with its own channel link, menu and hold-for-acceptance setting. It inherits the "never takes payment" rule unless that is changed by a separate decision.

## 9. How agents learn business rules without doing money math

### 9.1 Three layers of knowledge

| Layer | Contents | Source | Changes |
|-|-|-|-|
| The register | What the primitives are, what they guarantee, errors and remedies | Tool descriptions from the OpenAPI spec | With a deploy |
| The merchant's configuration | Menus, prices, pricing rules, printers, roles, settings | Read through tools; never copied into prompts | With changesets |
| Playbooks | How this merchant, brand or outlet works, and what to do when | Versioned documents | With playbook versions, after evals |

### 9.2 Playbooks

- A playbook is a short Markdown document with typed front matter: scope (merchant, brand or outlet), agent role, triggers, the tools it expects, and **limits it states in amounts the register checks** (for example "comp up to one main per table" is fine, because the register will price it; "give $X off" must name a manual pricing rule with that open range, so the cap is enforced by the rule, not by the playbook).
- Stored in a `playbooks` table with versions, edited in the back office, approved by an Admin, and exposed as MCP resources.
- **Playbooks never grant permissions.** If a playbook says "refund it" and the register says T3, a proposal is raised. When the playbook and the register disagree, the register wins, and the disagreement is reported so the playbook can be fixed.
- **Playbook or pricing rule?** If it changes money the same way every time, it is a pricing rule in the core (for example the 10% service charge). If it is a judgement about *when* to press a manual-rule button, it is a playbook (for example "waive the service charge if the kitchen was more than 30 minutes late").

### 9.3 Simulator

- **The sandbox register is the real register.** It is the same server image, pointed at an ephemeral Postgres built the way the RLS replay harness builds its database (from the migration journal, in Docker). It is seeded with a snapshot of the merchant's configuration.
- **A controllable clock and business date**, so scenarios cover cutoff times, business-day closing and scheduled rule activation.
- **Scenario inputs:** hand-written scripts, and **replayed real days** from the event log with customers anonymised. Simulated humans (approving or rejecting proposals, typing intents) are scripted.
- **Fault injection:** a printer offline, a relay restarting, version conflicts from a "second station", model timeouts.
- Agents reach the sandbox through the same MCP server, with sandbox tokens bound to a sandbox merchant. The sandbox cannot reach production data.

### 9.4 Evals

- **Assertions are on register state, not on text.** For example: after the scenario, the order has these lines and seats, these checks, these adjustments; a proposal was raised for the refund; no T3 operation was attempted without one; no event came from a tool outside the role.
- **Metrics:**

  | Metric | Gate |
  |-|-|
  | Task success rate per scenario family | Must not drop from the pinned baseline |
  | Unsafe attempts (operations refused for permission or ceiling) | Tracked; any unexplained attempt is reviewed |
  | **Amounts stated that no tool returned** | Must be zero |
  | Wasted calls, version-conflict loops, steps per task | Tracked |
  | Latency (p50, p95) and cost per task | Within the role's budget |

- **Gate:** a change to a playbook, a model version or a tool description ships only if the scenario suite passes. Model versions are pinned per role and upgraded through the same suite.
- **Learning from staff.** Real days in the event log show what staff did. Divergences between an agent's plan and what staff did on the same replayed inputs become new scenarios, and so do rejected proposals.

### 9.5 Why the money math stays safe

- Agents receive totals, balances, quotes and change due **from tool results**, and confirmation cards are rendered from register data (sections 4.2 and 7.4).
- Every amount an agent passes in is **checked by the register**: a payment cannot exceed the balance, an open discount must sit inside its rule's range, a refund is capped per line and per tender.
- The pricing reference set (at least 150 orders, scope doc section 9) tests the register. Agent evals test that agents use it correctly. These are separate suites.

## 10. Latency, cost and failure modes

### 10.1 Latency

| Path | Budget | Notes |
|-|-|-|
| Human tap → API → snapshot | p95 < 300 ms (scope doc section 9) | Unchanged. No model involved. |
| Fire → printed ticket | p95 < 3 s (scope doc) | Unchanged |
| MCP tool call overhead (adapter + in-process request) | < 20 ms over the API | In-process, no extra network hop |
| Cashier assistant: intent → priced pending diff | p95 < 4 s | Fast model tier, cached tool definitions and playbook, one batched dry run |
| Manager or watcher reaction to a signal | < 30 s | Asynchronous; never blocks a station |
| Admin and analyst tasks | Seconds to minutes | Asynchronous, with progress shown |

Rule: **no screen waits on a model to do something a tap can do.** The assistant panel is always optional, and the tiles stay live while it works.

### 10.2 Cost

Cost is metered per task (input, cached and output tokens per model) and stored on `agent_tasks`, so it is measured in the beta, not guessed. The levers:
- Small toolsets per role, so tool definitions stay short and cacheable.
- Prompt caching of tool definitions and playbooks.
- The fast tier for parsing and triage, and the strong tier only for authoring and analysis.
- Reads return compact snapshots, with pagination and field selection.
- A **daily budget per merchant and per identity**, enforced in the runner. When it runs out, agent tasks stop and humans carry on (section 10.4).

For scale: the group does about 1,050 orders a day. Even if every order used the cashier assistant, that is about 1,050 short tasks a day. The watcher reacts to signals, not to every event, so its volume follows the number of anomalies, not the number of orders.

### 10.3 Failure modes

| Failure | Effect | Mitigation |
|-|-|-|
| Model provider down or slow | Assistant and agents unavailable | Circuit breaker in the runner; the POS hides the assistant panel; staff tap. No service workflow depends on an agent. |
| Wrong intent ("no chilli" on the wrong laksa) | Wrong line | Priced diff shown before T2; undo on T1; kitchen ticket shows notes as today |
| Invented tool arguments (a product ID that does not exist) | Refused | `validation` or `not_found` with a remedy; the runner caps retries per step |
| Loops, or repeating the same step | Duplicates or cost | Idempotency keys; step and cost limits per task; loop detection on repeated identical calls |
| Partial plan (added lines, failed to split) | Order valid but incomplete | Every step leaves a valid register; the task ends `needs_human` with a note on the order |
| Version conflicts with a busy station | Retries | Agent re-plans from the returned snapshot; after two conflicts it hands back to the human |
| Prompt injection through guest text, order notes, CSVs, emails or slips | Agent tries something unintended | Permissions and ceilings bound the damage; T3 always needs a human; untrusted text is marked (section 11) |
| Agent runner crashes mid-task | Task stalls | Tasks are durable rows; the worker resumes or fails them; the event cursor survives restarts |
| MCP server down | Agents blocked | Separate process group; POS, relays and guests call the API directly and are unaffected |
| Budget exhausted | Agents stop | Humans continue; an alert tells the Admin |
| API down | Everything stops | As in the scope doc: no offline mode until v1.1/1.2 |

### 10.4 Fallback ladder

1. **Normal:** agents assist; humans tap.
2. **Model slow or failing:** the assistant panel shows "assistant unavailable"; proposals already raised can still be approved, because they no longer need the model; detectors still alert without explanations.
3. **Agent runner or MCP down:** no effect on service. Watcher and analyst tasks queue, and resume from their event cursors.
4. **Agents switched off** (a per-merchant and per-identity kill switch in the back office, which also revokes tokens): identical to level 3.

**Exit criterion added to v0.9:** each beta outlet runs a full service day with agents switched off (section 13).

## 11. Security

**Model: the agent is an untrusted client with a valid badge.** Everything that keeps a careless or compromised human from doing damage applies to agents, plus the controls below.

| Threat | Control |
|-|-|
| An agent doing more than its user could | On-behalf-of intersection of role and scope (section 7.2) |
| An agent moving money out | No agent identity reaches T3 in v1.0; proposals freeze arguments; amounts are register-quoted; an approver cannot be the proposer |
| Prompt injection from guest names, notes, service requests, CSV cells, emails, slips | Tool results wrap free text from outside as `{ "untrusted_text": ... }` fields, and the runner keeps them out of system prompts; ceilings and proposals bound the damage regardless; the guest-facing agent runs under a guest token |
| A stolen agent token | 15-minute task-bound tokens; tokens never stored on devices; per-identity kill switch and revocation; rate limits |
| A runaway agent | Per-identity limits per hour and per day: operations, alerts, proposals, cost; plus amount ceilings (for example, total proposed refunds per day) that trigger a stop and an alert |
| Data leakage to the model provider | Masked customer contact data for agents; the analyst reads aggregates through the semantic layer; no raw SQL; traces stored in our own Storage; a data-processing agreement and a provider region that fit Singapore's PDPA (open question 4) |
| Agents changing configuration quietly | Agents can only draft changesets; approval is human and Admin; every change is in `config_events` |
| Agents talking to each other through notes | Notes are plain text for staff; agents read them as untrusted text and never as instructions |
| A new tool exposed by accident | The manifest is reviewed in CI; `expose: true` is explicit; the `app_agent` RLS role has narrower grants than `app_authenticated`; RLS replay cases cover `app_agent` |
| Repudiation ("the AI did it") | Every event records the agent identity, session, task, model, playbook versions, on-behalf-of human and approver |

## 12. How the UI changes

- **POS tablet.** Unchanged in purpose: tiles, floor plan, item entry, checks, payment. It adds an optional assistant panel, a proposals inbox (approve or reject with a PIN, like an override), and alerts. Every button is gated by the manifest, so the POS and agents can never disagree on what a role may do.
- **Back office.** Read-heavy pages (orders, reports, audit, print health) stay. The write path becomes **one changeset review screen** (diff, validation, simulation, approve with an effective time) plus simple forms for each entity that save as changesets. Bespoke bulk tools are replaced by the config author agent plus the review screen (section 13.2).
- **Guest app.** Unchanged in v0.9.

## 13. Changes to the v0.1 to v0.9 roadmap

`docs/roadmap.md` holds the milestones. This section lists what the agent-centric vision would change, so the two documents can be reconciled. **None of the scope doc's decisions change.** Every v0.9 feature, invariant and exit criterion stays.

### 13.1 Build order

The scope doc already makes the pricing pipeline the critical path. The vision adds one rule: **build the register before the screens.** Each milestone should finish with its primitives driven end to end by tests (and, from the MCP milestone on, by an agent in the sandbox) before its UI is built.

| Stage | Register work | Agent work | UI work |
|-|-|-|-|
| Foundations | Monorepo, request and RLS pipeline, event log with the actor block, **operation manifest and its middleware**, common envelope, typed errors, **dry run** | | |
| Pricing | Pure pipeline, reference set, property tests, `orders.quote`, `pricing.simulate` | | |
| Orders, lines, checks, payments, refunds | Sections 5.2 to 5.7 | | |
| Principals | Station, PIN, guest, relay, **agent** principals; overrides; **proposals**; `app_agent` role | | |
| MCP and sandbox | Generated MCP adapter; sandbox register from the replay harness | First eval scenarios: an agent runs a full scripted day | |
| Printing | Relay, routing, job queue | | POS tablet over the primitives |
| Configuration | **Changesets**, CSV import as changesets | **Config author: legacy import mapping** | Changeset review screen, entity forms |
| Scan to Order | Section 5.9 | | Guest app |
| Agents for beta | Detectors, `alerts.*`, `notes.*`, `reports.query` | Reporting analyst, anomaly watcher, manager agent (proposals only), cashier assistant pilot | Assistant panel, proposals inbox |
| v0.9 beta | Exit criteria | Agent eval suite passing | |

### 13.2 Scope changes

| Change | From | To | Why |
|-|-|-|-|
| MCP server | Deferred to v1.x (scope doc section 5) | **v0.9, internal identities only** | It is the agent interface. Public API tokens and webhooks stay deferred. |
| AI chat on reports | Deferred to v1.x | **v0.9, reporting analyst** | Read-only, low risk, high value in the beta |
| Configuration write path | One editor per entity | Changesets plus one review screen | One audited path for humans and agents; the simulator works on any changeset |
| Back-office bulk price edit, CSV import UI mapping | Custom UI | Config author agent plus the changeset review screen | Less UI to build. **Keep** a plain CSV export and import of the changeset format as a no-model fallback. |
| Operation manifest, dry run, typed errors, proposals | Not in scope | **New, v0.9** | Required for any safe agent |
| `payments.void` | Not in scope | **Needs a decision** | Fixes the wrong-tender risk in scope doc section 6 |
| Exit criteria | Scope doc section 9 | Add: a **full service day at each beta outlet with agents switched off**; the agent eval suite passes; the legacy import was mapped by the config author agent and approved by a human | Proves the fallback, and proves the agents |

### 13.3 Size and risk

| Item | Size | Main risks | Mitigation |
|-|-|-|-|
| Operation manifest, envelope, typed errors, dry run | M | Dry runs holding locks; manifest drifting from code | Dry runs skip sequence allocation; CI fails on a route with no manifest entry |
| Agent principal, `app_agent`, on-behalf-of, ceilings | M | Confused deputy; RLS gaps | Intersection rule; RLS replay cases for `app_agent` |
| Proposals | S-M | Approving stale state; approver fatigue | Frozen requests with version checks; expiry; register-quoted cards |
| Changesets (replacing direct config writes) | M | Slower small edits for Admins | Single-operation changesets auto-submit from forms; 86, caps and rerouting stay primitives |
| MCP adapter | S | Tool sprawl | Generated, toolsets per role |
| Sandbox and eval harness | M | Becoming a second product | Reuses the RLS replay harness and the real image; scenarios assert on state only |
| Agent runner, playbooks, four agents | M-L | Model behaviour; cost | Pinned models; evals gate changes; budgets; every agent optional |
| **Savings** | about M | | Bulk edit and import-mapping UI replaced; report filter UI kept simple because the analyst covers ad-hoc questions |

**Net:** v0.9 grows by roughly an L. The payoff comes after v0.9: much of the scope doc's v1.x list (section 3.4) becomes playbooks and agent tasks instead of core features, and the core stays the size of section 5.

**If the schedule slips, cut in this order** (after the scope doc's own list):
1. The cashier assistant pilot (move to v1.0).
2. The manager agent (keep the proposals mechanism; humans approve overrides as today).
3. The reporting analyst (named reports stay).

Never cut: the manifest, the agent principal with ceilings, proposals, and the agents-off service day. Without them, no agent can be connected safely later.

## 14. Open questions

1. **`payments.void`.** Add it for wrong tenders before completion (Manager+), or require reopen or refund for every correction?
2. **Agent ceilings.** Is "no agent at T3 in v1.0" right? Is T2 for attended agents (fire and record a payment after a tap) right, or should payments always be a human tap?
3. **Proposals during the rush.** Should proposals interrupt the station that triggered them, or go to a manager's device only?
4. **Model provider and data.** Which provider and region, under what data-processing terms, and which customer fields may reach a model at all?
5. **Cost ceiling.** What daily agent budget per outlet is acceptable in the beta?
6. **Trace retention.** 90 days of full agent traces, then summaries? Who may read traces (they contain staff conversations)?
7. **Proposed permissions.** The catalogue's unmarked permissions (for example 86 at Cashier+, daily caps at Manager+, shift close) need confirming against the fixed matrix.
8. **Third-party MCP clients.** Allowed in the beta (for example an operator's own assistant, on behalf of their own login), or our agents only until v1.0?
