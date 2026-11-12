# Roadmap

What is built, what comes next and what Sail will not do. There are no dates. The [CHANGELOG](../CHANGELOG.md) has the history.

## Done

- The register: one API for every client, one transaction per request, row-level security on every tenant table, idempotency keys, optimistic concurrency, dry runs, typed errors with remedies, a per-outlet event log and live updates over SSE.
- Orders of four types (dine-in, takeaway, pickup, delivery) on one model; modifiers, seats, hold and send, voids, stock caps and sold out.
- A pure pricing engine for fees and discounts, with tax classes and rates, inclusive and exclusive prices, per-line or per-rate rounding and a hand-calculated reference set.
- Bills split evenly, by seat or by item; several tenders per bill; cash rounding; refunds by line or amount with refund receipts and credit notes; gap-free invoices.
- Shifts with blind cash counts, business days with a cutoff, Z-reports, sales, product mix, exceptions and print-health reports with CSV export.
- Kitchen and receipt printing through a relay, with routing, a durable queue, alerts, reprint and reroute.
- QR ordering at the table, without payment.
- Back office, iPad POS and guest app, with an end-to-end browser suite.
- Agent identities, risk tiers, proposals and an MCP adapter generated from the API spec.
- A payment-provider interface for card terminals: payments sent to the terminal as intents, an outbox the worker drains, signed and replay-protected webhooks, and a terminal simulator. `payments.void` for a payment recorded in error.
- Country-neutral configuration with region presets.

## Known gaps

- No screen shows proposals; staff approve them through the API.
- Pairing codes (stations and relays) have no attempt lockout.
- Agents cannot read customer contact columns at all.
- A few back-office pages name "today" by the calendar date in the merchant's time zone rather than the business date, so between midnight and the cutoff they show the next day.
- QR admission trusts the seating's first phone: whoever scans first after the table is seated orders without a staff tap.
- Production back-office sign-in needs a manual SQL step to link the login to a staff member ([self-hosting.md](self-hosting.md)); built-in sign-in will replace it.

## Next

- An adapter for a real card-terminal provider, and refunds of terminal payments given back through the provider (today they are given back on the terminal by hand).
- Linking a back-office login to a staff member without SQL, and a first-run setup flow.
- Typed responses in the API spec for order snapshots, floor, menu and documents (they are open records today, so clients mirror the types).
- Back-office screens for agent identities and proposals (both work through the API only).
- An independent second implementation of pricing, splits and refunds to test the engine against.
- Pricing conditions: time-of-day and day-of-week windows (happy hour), promo codes, buy N get Y.
- Station tokens that rotate on each PIN sign-in; alerts on PIN lockouts.
- Email and SMS delivery of digital receipts (links and QR codes work; sending needs a provider).

## Later

- Changesets: every configuration change drafted, validated, simulated against past orders and approved before it applies, by a person or an agent.
- An agent runner with playbooks, a sandbox register and evals, and assistants in the POS and back office.
- Masked customer views, so agents can work with customer records without seeing contact details.
- A kitchen display with bump and recall.
- Online payments and paying on the guest's phone, on top of the payment-provider interface. Today guests order and staff take payment.
- Offline order taking with sync.
- Fees that compound on other fees, usage limits per customer.
- Merging and splitting tables; uneven splits within one line; refunds that restore stock caps.
- E-invoicing, delivery-app integrations, menu translations, deeper modifier nesting.
- A native iOS client on the same API.
- Cash-drawer kick, USB and Bluetooth printers, label printers, customer displays.

## Not planned

- Inventory, purchasing, rostering and tip pooling.
- A second permission model for agents. Agents get the same roles and checks as people.
