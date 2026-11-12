# Sail v0.9 scope: the 80/20 cut

Status: draft for discussion, 29 Oct 2026. This revision records Phil's decisions to date:
- **Bills and refunds:** split by item and by seat. Partial refunds, with refund receipts and credit notes.
- **Scan to Order:** for ordering only; guests never pay on their phones.
- **Card payments:** a standalone bank terminal runs in parallel with Sail, with no integration.
- **Pricing:** one configurable rules engine for fees and discounts. The six common presets are kept as seed configurations.
- **Cash rounding:** a per-merchant setting, applied to cash only.
- **Order model:** one order model covering dine-in, takeaway, pickup and delivery.
- **Kitchen:** kitchen tickets and receipts print to network ESC/POS printers through a print relay at each outlet. The KDS is deferred.
- **Importer:** CSV-first.

Backend stack: Node.js (Hono + Drizzle), confirmed after reviewing Launchpad's architecture. Section 10 gives the conditions, the infrastructure notes and the gaps in Launchpad's setup.
Reference: `docs/reference/launchpad-architecture.md` (Launchpad main `42777e37`, 29 Oct 2026).

## 1. Goal and hard constraints

Sail is a multi-brand, multi-outlet restaurant POS. v0.9 is the first end-to-end, beta-testable release, for a group of 11 outlets and 9 brands (section 2). It covers about 80% of the core functionality such a group needs to run service. The rest is the set of complex edge cases that would take about 80% of the effort, and it is deferred.

| Constraint | Consequence for v0.9 |
|-|-|
| Tablet-optimised iPad frontend, browser-first | The POS and floor plan are designed for iPad Safari in landscape, with touch targets of at least 44 pt. The back office is a responsive web app: it must work on iPad, but it is mainly used on desktop. The **guest ordering web app** (Scan to Order) is the one surface designed for phones. |
| No native mobile app in v0.9 | We ship no app. The API is designed so that a native iOS client can use it later without changes (section 7). |
| Hardware: printers are the only exception | **The one hardware piece in v0.9 is network ESC/POS printing** for kitchen tickets and receipts, through a print relay at each outlet (section 4.7). Everything else is out: no payment-terminal integration, KDS, cash drawer, scale, barcode, buzzer or customer display. Card payments run on a standalone terminal and are recorded in Sail by hand (section 4.3). |
| Offline mode is v1.1/1.2 | v0.9 needs a network connection. Data-model choices still have to keep offline mode possible later (section 7). Queued print jobs survive a relay or printer outage. |
| Payment-processing fees | Out of scope for v0.9. |
| Supabase (Postgres) as the database; Fly.io for the backend, Vercel for the frontend | Supabase provides Postgres, Auth and Storage only, as in Launchpad. There is no Supabase Realtime, and browsers never call PostgREST. Schema migrations use Drizzle (section 10). |
| Reuse Mission's infrastructure patterns | Sail copies Launchpad's setup: monorepo, request and RLS pipeline, live updates over SSE, CI and deploy, secrets. It also takes the improvements Launchpad's engineer recommends for a new project (section 10.1). We do not invent new patterns. The print relay is the only new runtime, and it is a client of the same API and SSE stream. |

## 2. Target operating context

- **Group size:** 11 outlets and 9 brands, with 2-6 stations per outlet.
- **Catalogue:** about 20,000 products and components, about 5,600 modifier groups, about 400 menu sections and about 130 report categories.
- **People and volume:** about 110 staff and about 1,050 orders a day across the group.
- **Service styles:** full-service dine-in with floor plans, quick service, takeaway, pickup, delivery, and QR ordering at the table.
- **Object model:**
  - Merchant > Brand > Outlet > Station. Each outlet has Areas > Tables and printers.
  - Menus belong to a brand: Section > Product/Component > Modifier group > Modifier, where a modifier is itself a product.
  - Each order has an order type and a source channel.
- **Not needed for v0.9:** inventory, purchasing, rostering and tip pooling. The beta outlets don't run these in their current POS.

**Load profile.** Peak load is a few requests per second across the whole group. On top of that, open live-update (SSE) streams go to about 40 POS stations, 11 print relays, and any guests' phones that are waiting on an order. Database correctness matters far more than throughput.

## 3. How we drew the line

A feature is in v0.9 if it passes **both** tests:
1. **A beta outlet cannot run a service without it.** If it is missing, staff would have to go back to their current system or to paper for that shift.
2. **The cost is a normal feature's cost, not an edge-case tail.** Features that need open-ended rule engines, third-party partner approvals, hardware integrations, or card-present payment integration are deferred.

When a feature is core but has an expensive tail, we ship the common path and defer the tail.

**Phil's decisions override test 2 in two places:**
- **The pricing rules engine** (section 4.8). A configurable engine is normally the kind of tail we defer. It stays bounded because the condition types are fixed, the order of application is deterministic, and fees never compound.
- **Network printing** (section 4.7). This is the only hardware in v0.9.

The other additions (splits, partial refunds, Scan to Order) each ship their common path only. Section 6 gives the size and risk of each.

## 4. In scope for v0.9

### 4.1 Organisation, access and staff
- Merchant > Brand > Outlet > Station hierarchy, with `merchant_id` on every row from the start. The beta has one merchant, but the schema is multi-tenant.
- **Stations** are POS iPads bound to one outlet and one POS layout. Each station has:
  - a receipt printer,
  - optional station-specific kitchen printers, and
  - a "pay before firing" setting for counter service.

  A station is paired to an iPad with a one-time code, and the iPad keeps the resulting station token. Staff then sign in on the station with a 6-digit PIN.
- **Print relays** are paired to an outlet in the same way, using a relay token (section 4.7).
- **Roles:** five fixed roles (Server, Cashier, Manager, Finance, Admin) with a fixed permission matrix. For example:
  - charging and staff-applied discounts that are open to Cashier+ need Cashier+;
  - open-value discounts, open prices, refunds and voids after firing need Manager+;
  - managing past orders needs Finance or Admin;
  - editing pricing rules needs Admin.

  Each staff member is scoped to outlets and brands.
- **Manager override:**
  - A Manager+ PIN can authorise a single restricted action without switching the signed-in user: a discount above the user's role, an open price, a void after firing, or a refund.
  - The server issues a single-use override grant for that action.
  - The approver is recorded on the audit log.
- Back-office login uses Supabase Auth (email). PIN sessions on stations are short-lived and expire after inactivity.
- Audit log: who did what, on which order, line, check, refund or pricing rule, when, and who approved it.

### 4.2 Catalogue, menus and channels
- **Products and components** have a name, SKU, description, price (integer cents) and report category. They also have **product tags** (free-form labels, used for printer routing and for pricing-rule scope), a BCRS flag and an archived state.
- **Optional price per order type** on a product, for example a higher delivery price. When none is set, the base price applies.
- Modifier groups with minimum/maximum selection, maximum quantity per modifier, and a price override. Each modifier is a product. Modifier groups nest **up to 2 levels** for v0.9.
- **Channels:** v0.9 has two, **POS** and **Scan to Order** (dine-in only). A channel link (channel × outlet × brand × menu) decides which menu each channel shows at each outlet. Order numbers carry a source prefix (`P` or `QR`) and a per-outlet sequence.
- Brand-scoped menus with sections and one level of sub-sections.
- Availability: by outlet and channel, plus simple day-of-week and time windows. A full and/or condition builder is deferred.
- **Stock:** per-outlet "86" and daily quantity caps.
  - An item can be marked sold out for today, until a date, or indefinitely.
  - Caps count down automatically and block sales at 0.
  - Both POS and Scan to Order enforce them, and the server checks again when an order is submitted.
- Two-level global tree of report categories.
- **Legacy POS importer (a beta blocker), CSV-first:**
  - A one-way import from CSV exports of the incumbent system, which can be re-run safely.
  - It covers brands, outlets, menus, products, modifiers, tables, tender types, void reasons and staff. POS layouts are imported too, if they can be exported.
  - Records are matched by SKU or the legacy identifier, so a re-run updates rows instead of duplicating them.
  - The details of the CSV mapping are worked out later. An API import can be added if one turns out to be available.
- Back-office menu builder: CRUD, bulk price edit and CSV import/export. Drag-and-drop ordering of sections and products.

### 4.3 Orders and the POS (iPad, the heart of v0.9)
- **One order model with an `order_type`:** `dine_in`, `takeaway`, `pickup` or `delivery`. The types differ only in the reference they carry, the fields they need, and the price and fee rules keyed on them:

  | Order type | Reference | Extra fields |
  |-|-|-|
  | Dine-in | Table (and pax) | Seats (optional) |
  | Takeaway | Optional name or number | |
  | Pickup | Customer reference (name, mobile) | Ready-by time |
  | Delivery | Customer reference (name, mobile) | Delivery address, ready-by time, delivery notes |

  - The order type can be changed while the order is open; prices and fees are then recalculated.
  - Status: open → fired → ready → completed, or cancelled. Delivery adds a manual "out for delivery" step.
  - Riders, dispatch and courier booking happen outside Sail. Delivery-app integrations are deferred.
- **POS layouts:** one per brand, with pages > folders > tiles. Each tile has a colour and an access level (Everyone / Cashier+ / Manager+ / Admin). There is a back-office layout editor (grid-based; not a freeform designer).
- **Item entry:**
  - A modifier picker that enforces the min/max rules.
  - Quantity and notes.
  - **Seat number** (optional; turned on per station).
  - Open-price items (Manager+).
  - Item search.
- **Dine-in tabs:**
  - Open a table from the floor plan, add items, then **fire** them to the kitchen or **hold** them. Firing prints kitchen tickets (section 4.7). Fire held items later, and add more rounds.
  - Move an order to another table.
  - Scan to Order rounds land on the table's open order (section 4.6).
  - Several stations can edit the same order safely: the server uses optimistic concurrency, and clients catch up from the event log (section 7).
- **Floor plan:** areas and tables (imported). Each table shows its live status: free, seated, fired, bill requested or paid. It also shows elapsed time and a badge when QR rounds are waiting for acceptance.
- **Order list** for takeaway, pickup and delivery, sorted by ready-by time, with status and the customer reference.
- **Totals:** calculated by the server-authoritative pricing pipeline (section 4.8). The POS previews them with the same code, but the server's figures are what get stored.
- **Payments.** Payments are recorded against a **check** (a bill; section 4.4). An unsplit order has one check.
  - Several tenders per check, and part payments until the check's balance is 0.
  - **Card, on a standalone terminal with no integration:** the terminal runs in parallel with Sail.
    1. The server takes the card on the terminal.
    2. In Sail, they mark the bill paid with a **Card** tender. The amount is pre-filled with the check's balance and can be edited for a part payment.
    3. An optional free-text **reference** can be added.

    Sail never talks to the terminal.
  - PayNow and e-wallets taken on the terminal or on a static QR code at the counter are recorded the same way.
  - Other tender types come from a configurable list (imported). Each has an "opens cash drawer" flag, which is used only to work out expected cash, and an `is_cash` flag. House accounts (ENT, TAB, Invoice to…) are recorded the same way.
  - **Cash rounding (a per-merchant setting, off by default):**
    - The increment is configurable, for example 0.05.
    - It applies **only to cash tenders**: tender types with `is_cash`. It never applies to card, PayNow or other tenders.
    - It applies when a cash tender settles the remaining balance of a check. That balance is rounded to the nearest increment, with halves rounded up. The difference is recorded on the payment as `rounding_cents`.
    - Rounding never changes the bill's tax or line amounts, and it is reported on its own line.
  - Cash tips are recorded on the order. Card tips are not supported, because the terminal is not integrated.
  - There are no online or in-app payments in v0.9. Every payment is recorded at the POS.
- **Voids:** item void before payment, with a required reason from the configured list. A void after firing needs Manager+ and prints a **void ticket** to the printers that received the item. Cancel an order.
- **Refunds:** full and partial, with refund receipts and credit notes (section 4.5).
- **Reopen** a closed order on the same business day to correct it (Manager+). Reopening reverses that order's payments, and the order is then recharged.
- **Receipts:**
  - Printed on the station's receipt printer through the print relay (section 4.7). This covers the pre-bill for a table, the receipt for each check, and refund receipts.
  - Digital receipts: an email or SMS link, or a QR code on the screen.
  - Custom footer text and an option to show the outlet's phone number.
  - "Get invoice" produces a numbered PDF tax invoice for each check, including the outlet UEN.
- **Shifts and cash:**
  - Open a shift with a counted float and close it with a counted cash total. Expected vs actual cash, with the variance recorded. Cash rounding is included in expected cash.
  - Z-report per station or outlet for each business day, using a configurable business-day cutoff time. Named shifts (lunch/dinner) are used for reporting.

### 4.4 Bill splitting (split by item and by seat)
- **Checks:** an order has 1..N checks. Each check has its own totals, payments, receipt and invoice. Every order line is allocated to checks.
- **Split modes:**
  - **Evenly by N:** N checks, with every line shared 1/N.
  - **By item:** drag lines or quantities between checks. One item can be shared between checks in equal parts, for example a bottle of wine split 3 ways.
  - **By seat:** one check per seat number. Lines with no seat ("shared") are split evenly across the seats, or assigned by hand.
- **Allocation rules:**
  - The pricing pipeline already attaches every fee, discount and tax amount to order lines (section 4.8).
  - A check's totals are therefore the sum of its share of each line, with every component included.
  - Shared lines are allocated by each check's share, using the largest-remainder method on cents, with the order of checks deciding ties. This keeps the result deterministic.
  - **Invariant:** the checks always add up to the order to the cent. Cash rounding applies per check, at the time the check is paid in cash.
- **Locking:**
  - Once a check has a payment, its allocations are fixed. To move lines out of a paid check, refund it first.
  - The split can be undone or re-done freely until the first payment.
- **Seat cost:** seats add only a `seat_no` on the line, a seat picker in item entry, and the seat number on kitchen tickets. That is cheap, so splitting by seat is in v0.9.

### 4.5 Refunds
- **Full refund** of an order or of a single check.
- **Partial refund by line:** choose lines and quantities. Modifiers are refunded with their parent. The line's share of every fee, discount and tax amount is reversed in proportion, using the same allocation code as splits.
- **Partial refund by amount** (goodwill, for example $10 off for a late dish). The amount is spread across the check's lines in proportion, so the tax figures stay correct.
- **Tender selection:** the refund is assigned to one or more original payments. Each payment's refunds can never exceed what it paid, and each line's refunds can never exceed its paid amount.
  - **Cash refunds** reduce the expected cash in the drawer. If the merchant has cash rounding turned on, it applies to the cash refund too.
  - **Card refunds** are done on the terminal by staff and recorded in Sail as a card refund, with an optional free-text reference.
- **Documents:**
  - Every refund produces a **refund receipt** that is linked to the original bill: it carries the original check number and date. The receipt can be printed or sent digitally.
  - If the original check had a tax invoice, Sail also produces a numbered **credit note** PDF that references the invoice number.
  - InvoiceNow/Peppol e-invoicing is deferred, because it is only needed for B2B customers.
- **Permissions:** Manager, Finance or Admin, or a lower role with manager override. A reason is required.
- **Reporting and stock:**
  - Refunds count on the business day they happen, not the day of the original sale.
  - Refunded items do **not** restore daily stock caps in v0.9.

### 4.6 Scan to Order (QR ordering at the table, ordering only)
Scan to Order is a shortcut that lets guests send orders to their own table instead of a server keying them in. **It never takes payment.** Guest orders land on the table's open dine-in order, and the bill is paid at the POS as normal, with splits, pricing rules and any tender.

- **Guest web app:** a Next.js app on Vercel designed for phones, on its own subdomain. Guests do not log in. It uses English only in v0.9.
- **Table QR codes:**
  - Each table has a permanent QR code: a URL with an opaque **table token**, which can be rotated from the back office.
  - The back office generates printable PDF sheets of the codes, which can be printed on any ordinary printer.
- **Guest session:**
  1. Scanning the code calls `POST /v1/guest/sessions` with the table token.
  2. This returns a short-lived **guest token**, scoped to the merchant, outlet, brand, channel, table and the table's open order.
  3. Session creation and order submission are rate-limited per device and per table.
- **Ordering:**
  - Guests can order only while the table has an open order. By default a server opens it when seating the table, which stops prank orders from a photographed QR code. An outlet can turn on "open on first scan" per channel.
  - Each guest submission is a **round** that is added to the table's open order.
  - With "hold orders" on, the round waits on the POS for staff to accept it before it fires and prints. With it off, the round fires and prints straight away.
  - When the order is paid and closed at the POS, every guest session for it expires.
- **Guest features:**
  - Browse the channel's menu, with prices, availability and 86 applied.
  - Modifier picker with the same rules as the POS.
  - Order notes, and an optional name.
  - Round status: sent, accepted, preparing, done.
  - A view of what the table has ordered so far.
- **Call for bill and service requests:**
  - Up to 5 configurable requests per channel (for example water or cutlery). They appear as notifications on the outlet's POS stations, and can optionally print a slip on a chosen printer.
  - Call for bill also changes the table's status.
- **Pricing:** guests see menu prices only. Fees and automatic discounts are calculated on the table's order and shown on the bill at the POS. Guests cannot enter promo codes.

### 4.7 Kitchen tickets and receipt printing (network ESC/POS through a print relay)
The KDS is **out** of v0.9 (section 5). Kitchens work from printed tickets.

**Choice: a small print relay at each outlet.** Each relay is an always-on device on the outlet LAN. It holds an outbound connection to the Sail API, receives print jobs, and sends raw ESC/POS bytes to the printers over TCP port 9100.

**Why this option.** It is the simplest option that works with any network ESC/POS printer and loses no tickets:

| Option | Why not (or why) |
|-|-|
| Direct from the iPad browser to the printer | Browsers cannot open raw TCP sockets. Vendor HTTP print APIs called from the browser need HTTPS certificates on each printer to be trusted by each iPad, which is fragile. Printing would also stop whenever the iPad that fired the order sleeps or loses its connection. |
| Direct from the cloud API to the printer | Printers sit behind each outlet's NAT. Reaching them needs port forwarding or a VPN per outlet, which is fragile and a security exposure. |
| Printer-side cloud polling (vendor-specific modes where the printer fetches jobs over HTTPS) | Needs no relay device, but only some printer models and firmware support it, and each vendor uses a different protocol. Polling adds latency. The printer models at the outlets are not yet known. Worth revisiting if outlets standardise on printers that support it. |
| **Print relay (chosen)** | Works with **any** network printer that accepts raw ESC/POS on port 9100. Connections are outbound only, so no firewall changes are needed. Jobs are stored durably on the server, so nothing is lost if a relay or printer is down. It reuses the SSE stream and catch-up from section 7. The cost is one small device per outlet (11 in total), which Ops installs and keeps powered. |

**Design:**
- **Relay software:** a small Node service in the monorepo (package `relay`), shipped as a Docker image for arm64/amd64 single-board computers or mini PCs. It is paired with a relay token.
  - It pulls its printer list from the API.
  - It holds an SSE stream (`GET /v1/relays/{id}/stream`) and catches up on jobs after every reconnect.
  - It sends a heartbeat every 30 s, so the back office shows when each relay was last seen.
  - It updates itself by pulling a pinned image tag.
  - The relay holds no business logic.
- **Jobs are rendered on the server.** The `shared` package contains the ESC/POS renderer, so templates change with a normal deploy and the relay stays simple. There are templates for:
  - kitchen ticket, void ticket and reprint (each marked with a banner),
  - pre-bill, receipt and refund receipt, and
  - service-request slip.

  Paper widths of 80 mm and 58 mm are supported. Large type is used for item lines, with modifiers indented. Tickets also show notes, seat, table or customer reference, order type, server, time, round number and job ID. Item names in Chinese or other CJK scripts print as an image if the printer lacks the code page (section 8).
- **Routing.** When items fire, the server builds **one job per target printer** in the same transaction as the fire event:
  - **Outlet kitchen printers** have include and exclude product tags, plus optional filters for order type and source (POS or QR). An item goes to every printer whose rules match it. Copies are configurable for each printer.
  - **Station printers:** the station's receipt printer handles bills, receipts and refund receipts. Optional station-specific kitchen printers handle items fired from that station, for example a bar station printing to the bar printer.
  - Items that match no printer go to the outlet's default kitchen printer. The back office warns about products whose tags route nowhere.
- **Delivery and failure handling:**
  1. Each job moves through `queued → claimed → printed`, or to `failed`.
  2. The relay claims a job, sends it, and acknowledges it with its result.
  3. If a connection fails or times out, the relay retries with backoff. Where the printer supports a status query (DLE EOT), the relay checks paper and cover status before printing.
  4. If a job is not printed within 10 s, the POS shows an alert, for example "Kitchen printer offline, 3 tickets waiting". From there staff can **reprint** or **reroute to the configured backup printer**.
  5. The worker re-queues claims that go stale, for example when a relay dies mid-job.

  Every job has an ID, and retries reuse it. A partial send can print a duplicate, which is accepted.
- **Target:** p95 time from firing to a printed ticket under 3 s.
- **Not in v0.9:** cash-drawer kick (the ESC/POS pulse command is trivial to add later), USB or Bluetooth printers, and label printers.

### 4.8 Pricing rules: one configurable pipeline for fees and discounts
This replaces both the fixed discount library and the hard-coded service charge and BCRS.

**Fees and discounts are the same kind of record:** a **pricing rule**. Each rule has the fields below.

| Field | Values |
|-|-|
| `kind` | `fee` or `discount` |
| Name | Shown on receipts and reports |
| Calculation | `percent`, `fixed_per_order` or `fixed_per_unit` |
| Value | Fixed, or **open** (entered when applied, between a minimum and a maximum) |
| **Scope** (which lines it applies to) | All items, report categories, products, or product tags. Exclusions are allowed. |
| **Conditions** (when it applies) | Order types; channels; outlets and brands; **minimum spend**; **customer groups**; active date range. All listed conditions must hold. |
| Minimum spend basis | Either the scoped items' subtotal or the order subtotal |
| **Cap** | The maximum amount for each order, for discounts or fees |
| **Order of application** | An integer priority. Ties are broken by rule ID, so the result is deterministic. |
| Stacking (discounts) | `exclusive` stops lower-priority discounts on the lines it touched. `stackable` does not. |
| Application | `auto` (applies whenever its conditions hold) or `manual` (staff pick it on the POS) |
| Roles (manual only) | The minimum role that can apply it, whether a manager override is allowed, and whether a reason is required |
| GST (fees) | Whether GST applies to the fee |
| Reporting class | For example service charge, deposit, delivery fee, promo, comp, staff meal or ENT |

**The pipeline** is one pure function in `shared`. The POS preview, the server, the back-office simulator and refunds all call the same function:
1. **Base prices.** Each line's price is the product price for the order type (falling back to the base price), plus modifiers, times quantity.
2. **Line-level discounts** (rules scoped to items, categories or tags) apply in priority order. Each one applies to the running amount of each line in scope, and `exclusive` rules stop the ones below them.
3. **Order-level discounts** (rules scoped to all items with an order-wide value, such as $10 off the bill) apply in priority order. They are spread across the eligible lines in proportion to each line's amount.
4. **Fees** apply in priority order. A percentage fee is calculated on the discounted amount of the lines in its scope, and fixed-per-unit fees are calculated on quantity.
   - **Fees never compound in v0.9:** no fee is calculated on top of another fee.
   - Every fee amount is attached to the lines it came from.
5. **GST** is calculated per line on the discounted line amount, plus every fee marked as GST-applicable. Whether prices include or exclude GST is a per-merchant setting (section 8).
6. **Caps** are applied to each rule's total, and any reduction is spread back across that rule's lines.
7. **Rounding to cents** uses the largest-remainder method for each rule, so every rule's line amounts add up exactly to the rule's total.

The output is a list of **adjustments**: one per rule application, holding a snapshot of the rule and an amount for each line. Splits (section 4.4) and refunds (section 4.5) only ever work on these per-line amounts.

**Re-evaluation and freezing:**
- The pipeline runs again whenever an open order changes: a line is added or voided, the customer changes, the order type changes, or a manual rule is applied.
- **Once any payment exists on the order, the results of order-level and minimum-spend rules are frozen.** Lines added after that are priced with line-level rules only. This stops a paid check from changing under the customer.

**Customer groups:** a customer can belong to groups, such as VIP, corporate account or staff. A group condition matches only when a customer is attached to the order, either by staff at the POS (looked up by mobile) or as the order's pickup or delivery customer.

**Editing rules safely:**
- Rules are edited in the **back-office pricing section** (Admin only).
- A **simulator** prices a sample basket for a chosen outlet, order type and customer group, and shows every step of the pipeline.
- Validation flags likely mistakes: overlapping exclusive rules, products no fee covers, and caps below the minimum.
- Changes take effect at a scheduled time. Each change creates a new rule version, and orders keep the snapshot they were priced with.

**Seed configuration (every new merchant starts with these, all editable):**
- **Fees:**
  - Service charge: 10%, all items, dine-in only, GST-applicable.
  - Container deposit (BCRS): $0.10 per unit on products flagged BCRS, not GST-applicable, with per-outlet exclusions.
- **Manual discounts** (the six presets):
  - % off bill (open %, Manager+).
  - $ off bill (open $, Manager+).
  - % off item (open %, Cashier+, with a cap).
  - Staff meal (fixed %, Cashier+, reason required).
  - Manager comp (item 100% off, Manager+, reason required).
  - Service-charge waiver (removes the service charge from the order, Manager+, reason required). This is implemented as a manual rule that switches off the service-charge fee for that order.

**Worked example.** Rule A is "25% off food": auto, scoped to the Food category, priority 10. Rule B is "10% off alcohol above $100 for certain customers": auto, scoped to the Alcohol tag, minimum spend $100 on scoped items, customer groups VIP or Corporate, priority 20. The service-charge fee is priority 100.

A VIP customer orders $80 of food and $120 of wine:
- Rule A takes $20 off the food.
- Rule B takes $12 off the wine, because the $120 wine spend clears the $100 minimum.
- The service charge is 10% of $168, which is $16.80.
- GST is then calculated per line and on the service charge.

### 4.9 Customers and customer groups (minimal)
- Customers have a name, mobile, email, marketing consent and **groups**. Staff attach a customer to an order by looking up their mobile. Pickup and delivery orders create or match a customer from their reference.
- Customer groups are managed in the back office and used by pricing-rule conditions.
- Existing customers are imported from CSV if available. They are not needed for the beta.

### 4.10 Reporting (operational, built in, no BI embed)
- **Daily outlet report and Z-report:**
  - Gross and net sales.
  - **Fees and discounts by rule and by reporting class**, and refunds.
  - GST, tips and **cash rounding**.
  - Covers and order count, broken down by order type.
  - Sales by tender, expected vs actual cash, and voids.
- **Sales summary:** filters for date range, outlet, brand, station, shift, source (POS/QR), order type, staff and report category.
- **Product mix:** by item, by category and by staff member.
- **Void, discount and refund report:** shows who voided, discounted or refunded, who approved, the reason, and which rule was applied.
- **Print health:** jobs that failed, were rerouted or were reprinted, by printer and relay.
- CSV export on every report. A printable/PDF daily summary.
- Reports read from SQL views or materialised views on Supabase. There is no separate analytics stack in v0.9.

### 4.11 Back office (web)
- **Setup:**
  - Outlets (hours, UEN, business-day cutoff), brands and stations (receipt printer, station kitchen printers, pay-before-firing).
  - Tables & areas, with QR sheets.
  - Channels and channel links, including Scan to Order options: who opens the table, hold orders and service requests.
  - Team & roles, tender types, void reasons, menus (including prices per order type), layouts and receipt settings.
- **Pricing section:** pricing rules, the simulator, customer groups, and the merchant's tax and cash-rounding settings.
- **Printing:** printers (IP address, paper width, tags, filters, copies, backup printer), relays (pairing, last seen) and test prints.
- **Reports** (section 4.10).
- **Orders:** today's orders and all orders, with an order detail drawer. The drawer shows status, order type, checks, lines, adjustments, payments, refunds, print jobs and the audit trail. It has actions to refund, reprint and produce an invoice or credit note.

## 5. Deferred (the 20% that costs about 80%)

| Area | Deferred item | Why it is expensive | Target |
|-|-|-|-|
| Offline | Offline order taking and sync | Conflict resolution, local queues and idempotent replay | v1.1/1.2 (per brief) |
| Kitchen | **KDS** (kitchen display screens, bump, ticket timers, production-time reporting) | Phil's decision: kitchens use printed tickets in v0.9 | v1.0 |
| Payments | **Card-terminal integration** (pushing the amount to the terminal and getting the result back), integrated online and in-person card processing, card tipping, terminal settlement reconciliation | Hardware, acquirer contracts and certification. v0.9 runs the terminal in parallel and records a card tender (section 4.3) | v1.x |
| Payments | Dynamic PayNow QR at the counter with automatic confirmation | Needs a bank or payment-provider webhook. Static QR plus manual confirmation is v0.9 | v1.0 |
| Payments | Split by uneven fractions (for example 60/40 on one line), splits of checks that are already paid, refunds that restore stock caps, exchanges | The tail of splits and refunds | v1.x |
| Documents | InvoiceNow/Peppol e-invoicing | B2B only; PDF invoices and credit notes cover v0.9 | v1.x |
| Hardware | Cash-drawer kick, USB or Bluetooth printers, label printers, scale, barcode, buzzer, customer-facing display | Hardware beyond network ESC/POS printing | v1.x |
| Scan to Order | **Any guest payment:** pay before ordering, pay the bill on the phone, guest bill splitting, online payment providers | A money-movement integration (provider onboarding, webhooks, provider-side refunds). Phil's decision: ordering only in v0.9 | v1.x |
| Scan to Order | Menu translations, self-service pickup modes and pickup-number paging, guest promo codes, guest customer profiles, kiosk | The tail of Scan to Order | v1.0+ |
| Channels | **Delivery-app integrations** (menu sync, order injection), online storefront, timeslots and lead-time rules, distance-based delivery fees, rider dispatch and courier booking | Partner API approvals and large rule surfaces. In v0.9 delivery is an order type with a flat delivery fee rule, and aggregator orders are keyed in with an aggregator tender | v1.x |
| Pricing | Time-of-day and day-of-week rule conditions (happy hour), buy-N-get-Y and cheapest-item rules, fees that compound on other fees, usage limits per customer or period, promo codes and bulk codes, saved customer promotions | Each one adds a combinatorial tail to the pipeline. The v0.9 condition set is fixed (section 4.8) | v1.x |
| Menus | Full availability-condition builder (and/or), translations, cross-sell, nested modifiers deeper than 2 levels, allergen/nutri-grade display | Rule engines and channel-specific features | v1.0+ |
| Floor | Merge or split tables, reservations integrations | Edge-case heavy | v1.0 |
| CRM and marketing | Loyalty, referrals, drip, announcements, banners, pop-ups, segments beyond customer groups, email/SMS marketing integrations | Not used by the beta outlets today, or used only online | v1.x |
| Reporting | Customer cohorts and LTV, forecasts, payout reconciliation, scheduled report delivery, AI chat, BI embeds | Payout data needs payments integration; the rest is BI | v1.x |
| Platform | Public API tokens, webhooks, MCP server, custom roles, multi-merchant self-serve onboarding | Not needed to run the outlets | v1.x |
| Native | iOS app | Planned once the browser core is stable (per brief) | later |

**Not planned for Sail POS:** inventory, purchasing, rostering and tip pooling. Mission Sourcing and Workforce may cover these separately.

## 6. Size and risk

Sizes are relative to the rest of v0.9: S is a few days, M is one to two weeks, and L is several weeks, for one full-stack developer.

**Overall size after this round of decisions:**
- **Smaller:** taking the KDS out of v0.9 saves about an M.
- **Larger:** the pricing rules engine (L) and network printing (M) add more than that saved.
- **Net:** v0.9 is larger than before this round. The **pricing pipeline is now the critical path and the top correctness risk.** Splits, refunds, receipts, invoices and reports all depend on its per-line adjustments, so it has to be built and tested first.
- **Third parties:** v0.9 still depends on none. Its only physical dependencies are printers and relay devices at the outlets.

**If the schedule slips, cut in this order:**
1. Scan to Order: the most self-contained item, so it moves to v1.0.
2. Automatic customer-group discounts: manual rules keep using the same pipeline.
3. Split by shared item: whole-line splits and even splits stay.

| Change | Size | Main risks | Mitigation |
|-|-|-|-|
| **Pricing rules engine (fees + discounts, one pipeline)** | **L** | Rule combinations producing surprising totals. Ambiguity about the order of application. Automatic minimum-spend discounts flipping on and off as lines change. Caps and GST on fees allocated inconsistently across lines, checks and refunds. Admins misconfiguring rules on live tills. Scope creeping towards a general engine. | One pure function, shared by the POS preview, server, simulator and refunds. A fixed set of condition types. Deterministic priority with rule-ID tiebreak. No compounding fees. Order-level results frozen at first payment. Rule versions with scheduled activation and per-order snapshots. Back-office simulator and validation warnings. Reference set extended to every rule type, plus property tests (each rule's lines add up to its total, caps are never exceeded, no discount exceeds its line, checks add up to the order). Anything outside section 4.8 needs a new decision. |
| **Network printing through a print relay** | M | Printer offline, out of paper or cover open. Raw TCP gives no feedback, so jobs can be "sent" but never printed. Relay device unplugged or crashed. Outlet network problems. Duplicate tickets after a retry. CJK item names. Installing and updating 11 devices. Kitchen tickets are now safety-critical for service. | Durable job queue on the server, with job IDs printed on every ticket. Status query (DLE EOT) where supported. A POS alert when a job is not printed within 10 s, with reprint and reroute to a backup printer. The worker re-queues stale claims. Relay heartbeats are shown in the back office and trigger alerts. Image rendering as a fallback for CJK. Docker image with pinned automatic updates. A spare relay device per beta outlet. Failure drills before the beta (section 9). |
| Bill splitting (by item, evenly, shared items) | M | Cent rounding across checks. Lines moved after a payment. | Checks are sums of the pipeline's per-line adjustments, so allocation exists only once. The sum-equals-order invariant is asserted in the database and in tests. Checks lock on first payment. |
| Split by seat | S | Shared items with no seat | Shared lines default to an even split across seats |
| Partial refunds, refund receipts, credit notes | M | Over-refunding. Tax reversed inconsistently with the original sale. Business-day attribution. Credit-note numbering. | Caps per line and per payment enforced in the database. Reversal works on the per-line adjustments. Refunds dated by business day. Credit notes numbered with a gap-free sequence per merchant. |
| Order types (dine-in, takeaway, pickup, delivery) | S-M | Fields that apply only to some order types leaking into the others. Changing the order type mid-order. | A single model with validation per type. Changing the type triggers a full re-price before any payment, and is blocked after one. |
| Cash rounding setting | S | Applied to non-cash tenders. Interaction with part payments. | Applied only on the cash tender that settles the check, and only for tender types with `is_cash`. Covered in the reference set. |
| Scan to Order (ordering only) | M | A second frontend for phones and anonymous traffic. Prank or abusive orders. Guests and staff adding to one order at once. | Server-opened tables by default. Rotatable table tokens and rate limits. Optional "hold orders" acceptance. Guest rounds go through the same API with optimistic concurrency. |
| Live updates over SSE (Launchpad pattern) | S (reused) | **iPad Safari** drops streams when the screen locks or the tab goes to the background. **Rolling deploys** cut every stream. **Fly concurrency limits** count every open SSE connection. **Missed notifications** when the `LISTEN` connection drops, because `pg_notify` is not durable. | Catch-up from the event log (and the print-job queue) on reconnect, on a sequence gap, on page visibility and on `resync`. Concurrency limits sized for connections, with at least 2 machines always running. No deploys during service hours. |
| Card terminal in parallel, no integration | S | Keying errors. A card charged but the bill not marked paid, or the reverse. The wrong tender chosen. A refund done on the terminal but not recorded in Sail. | The amount is pre-filled from the check's balance. An idempotency key stops a double tap from recording the tender twice. As a closing procedure outside Sail, the manager compares the Z-report card total with the terminal's own end-of-day total. |

## 7. API design rules and data model

### 7.1 Rules (so a native iOS app and offline mode fit later)
1. **The API owns all business logic.**
   - Pricing, allocation, tax, permissions, state transitions, stock decrements and print routing live on the server.
   - The Next.js apps (POS, back office and guest ordering) and the print relay are only clients of the public `/v1` API.
   - Browsers never use PostgREST or read or write Supabase tables directly, so a Swift client gets exactly the same behaviour.
   - Every API request runs inside one database transaction with RLS applied (rule 8; section 10.2, condition 4).
2. **Versioned REST + JSON with a generated OpenAPI spec**, kept as the contract. A Swift client is generated from it later. Guest endpoints (`/v1/guest/*`) and relay endpoints (`/v1/relays/*`) are in the same spec.
3. **Client-generated UUIDs** for orders, lines, checks, payments and refunds, plus an **`Idempotency-Key` header on every mutation**. This makes retries safe now, including a card tender submitted twice. The same mechanism replays offline queues in v1.1. Print jobs have their own IDs, assigned by the server.
4. **Orders store an append-only event log** alongside the current-state tables. Events cover lines added, fired, voided and split; adjustments recalculated; payments and refunds; guest rounds submitted and accepted; and print jobs created and printed.
   - Each event gets a **per-outlet sequence number**, assigned in the same transaction as the state change.
   - The log is the audit trail and the source of truth for every client's view, and it gives offline sync something to merge against.
   - Clients can always catch up with `GET /v1/outlets/{id}/events?after={seq}`.
5. **Optimistic concurrency** using an order `version` (or ETag/If-Match). Two stations, or a station and a guest, editing one order fail cleanly instead of overwriting each other.
6. **Integer cents everywhere** in the API and webhooks, so dollars and cents are never mixed.
7. **Live updates use SSE fed by `pg_notify`, reusing Launchpad's pattern.** Supabase Realtime is not used. The SSE stream only signals that new events exist; the event log, and for relays the print-job queue, stays the source of truth.
   1. **Signal.** Triggers on `order_events` and `print_jobs` call `pg_notify('sail_events', …)` with a small payload: the outlet, the sequence number or job ID, and the event type. Notifications are sent only when the transaction commits.
      - The per-outlet sequence is assigned under a lock on the outlet's counter row. Commits for one outlet are therefore delivered in sequence order.
   2. **Stream.** Each API machine runs `LISTEN` on **one dedicated session connection (port 5432)**, as Launchpad does; a test rejects 6543. It fans each notification out to its SSE clients:
      - `GET /v1/outlets/{id}/stream` for POS stations,
      - `GET /v1/relays/{id}/stream` for print relays, and
      - a per-order stream for guests.

      Streams are served with Hono `streamSSE`. Before a stream opens, the server checks access in a short RLS transaction.
   3. **Catch-up.** Clients use `fetch` streaming, not `EventSource`, because they must send a Bearer token. A client catches up whenever:
      - it reconnects,
      - it sees a gap in sequence numbers,
      - the page becomes visible again (iPad Safari suspends background tabs), or
      - the server sends a `resync` event, which it does after its own `LISTEN` connection drops and recovers, because `pg_notify` is not durable.

      POS stations catch up from the event log. Relays catch up by fetching their outstanding jobs (`GET /v1/relays/{id}/jobs?status=queued`).
   4. **Heartbeats.** A comment line every 20 s keeps proxies from closing idle connections.
   5. Correctness never depends on delivery of a notification. The API stays the only writer.
8. **Auth and RLS:** all of these are plain bearer tokens, so a native app can use them.
   - **Token types.**
     - Back-office users: Supabase JWTs verified against the JWKS, with Launchpad's `authMiddleware`. If Mission standardises on Passport SSO for staff, add it as Launchpad does.
     - POS stations: station tokens plus a PIN session.
     - Guests: **guest tokens**. They are short-lived and scoped to one table and that table's open order. They can only read the channel's menu and their table's order, submit rounds, and send service requests. They have no access to payments.
     - Print relays: **relay tokens**. They can only read their outlet's printers, and claim and acknowledge their outlet's print jobs.
   - **RLS on every request.** Launchpad's `rlsMiddleware` resolves every principal and sets `app.current_merchant`, `app.current_outlet`, `app.current_principal` and `app.current_principal_type` with `set_config`. It then runs `SET LOCAL ROLE`:
     - `app_authenticated` for staff and stations.
     - New narrow roles: `app_guest` for guests and `app_relay` for relays.
   - **RLS opt-out routes** go on the same tested list as Launchpad's (`rls-opt-out.ts`). For Sail this is `/health` only.
9. **Manager override** is a single-use grant from `POST /v1/overrides`, bound to one action and target. The protected request carries the grant ID. Overrides are never a session switch.
10. **Pricing is a pure function in `shared`:** `price(order, rules, context) → adjustments`. It takes no I/O and no clock reads, and its inputs are explicit. The server, the POS preview and the simulator all call it. Tests feed the reference set and property-based baskets through the same function.

### 7.2 Data model
Every table carries `merchant_id` and `outlet_id` where relevant. Money is in integer cents.

| Entity | Key fields | Notes |
|-|-|-|
| `merchant_settings` | tax_mode (`inclusive`, `exclusive`), cash_rounding_increment (null = off), business_day_cutoff | Per merchant |
| `channels`, `channel_links` | type (`pos`, `scan_to_order`), hold_orders, open_on_first_scan, service_requests[], outlet, brand, menu | Settings per channel link |
| `products` (extended) | tags[], is_bcrs | Tags drive both printer routing and pricing-rule scope |
| `product_prices` | product_id, order_type, price | Optional price for each order type |
| `orders` | order_type (`dine_in`, `takeaway`, `pickup`, `delivery`), table_id, pax, customer_id, customer_ref (name, mobile), delivery_address, ready_by, status, version, pricing_frozen_at | One model; validated per order type |
| `order_lines` (extended) | `seat_no` (nullable = shared), `source` (`pos`, `guest`), `round_id` | Seats and QR rounds |
| `pricing_rules` | kind (`fee`, `discount`), name, calc, value or open min/max, scope (all, categories, products, tags, exclusions), conditions (order_types, channels, outlets, brands, min_spend plus basis, customer_group_ids, date range), cap, priority, stacking, application (`auto`, `manual`), min_role, override_allowed, reason_required, gst_applicable, report_class, seeded, version, effective_from | One table for fees and discounts. Conditions use a fixed JSON schema, validated with zod. |
| `order_adjustments` | order_id, rule_id plus version, rule snapshot, kind, total, applied_by, approved_by, override_id, reason, entered_value (open rules) | One row per rule application |
| `order_adjustment_lines` | adjustment_id, order_line_id, amount, gst_amount | The per-line amounts. Splits and refunds read only these. The sum per adjustment is enforced. |
| `checks` | order_id, index, label, status (`open`, `paid`, `refunded`), totals, `locked_at`, invoice_no | One per bill |
| `check_allocations` | check_id, order_line_id, share_num, share_den, allocated cents for each component | The sum over checks equals the line, enforced in the database |
| `payments` (extended) | check_id, tender_type_id, amount, rounding_cents, tip, reference (optional free text), status, entered_by | `tender_types.is_cash` controls rounding |
| `refunds` | order_id, check_id, kind (`full`, `lines`, `amount`), reason, refunded_by, approved_by, business_date, refund_receipt_no, credit_note_no (when the check was invoiced) | Linked to the original check and invoice |
| `refund_lines` | refund_id, order_line_id, quantity, reversed cents for each adjustment and for GST | Each line's refunds are capped at its paid amount |
| `refund_tenders` | refund_id, payment_id, amount, rounding_cents, reference | Each payment's refunds are capped at what it paid |
| `document_sequences` | merchant_id, kind (`invoice`, `credit_note`, `refund_receipt`), next_no | Gap-free numbering, incremented inside the transaction |
| `customers`, `customer_groups`, `customer_group_members` | | Used by pricing-rule conditions |
| `printers` | outlet_id, name, ip, port (9100), paper_width, role (`kitchen`, `receipt`), station_id (nullable), include_tags[], exclude_tags[], order_types[], sources[], copies, backup_printer_id, is_default_kitchen | Routing configuration |
| `print_relays` | outlet_id, name, token hash, last_seen_at, version | One per outlet; a spare can be paired |
| `print_jobs` | outlet_id, printer_id, kind (`kitchen`, `void`, `prebill`, `receipt`, `refund_receipt`, `service_slip`, `reprint`), order_id, check_id, payload (ESC/POS bytes), status (`queued`, `claimed`, `printed`, `failed`), attempts, claimed_by, claimed_at, last_error, printed_at, reprint_of | Durable queue |
| `table_qr_tokens` | table_id, token hash, rotated_at | Rotating a token invalidates old QR codes |
| `guest_sessions` | table_id, channel_link_id, order_id (the table's open order), device fingerprint, expires_at, revoked_at | Revoked when the order is paid and closed |
| `guest_rounds` | order_id, guest_session_id, status (`pending`, `accepted`, `rejected`, `fired`), accepted_by | "Hold orders" queue |
| `service_requests` | table_id, guest_session_id, type, status, acknowledged_by | Shown as POS notifications, with an optional printed slip |
| `overrides` | action, target, approver_id, requester_id, used_at, expires_at | Single-use |

## 8. Open questions to settle before the build

1. **Tax and fee defaults:**
   - Are menu prices GST-inclusive at every outlet? This sets the merchant `tax_mode`.
   - Confirm the seeded service-charge rule: 10%, dine-in only, calculated on discounted amounts, with GST applied to it.
2. **Printers:**
   - Which printer models are at the beta outlets, and do they accept raw ESC/POS on TCP port 9100 at fixed or reserved IP addresses?
   - Do any item names on tickets need Chinese or other CJK characters? That decides whether we need code-page support or image rendering.
3. **Relay devices:** who supplies and installs one small always-on device per outlet (plus a spare)? Does each outlet have a wired LAN port near its printers' network?

## 9. Exit criteria for v0.9 (beta-ready)

- **Full service day:** each of the 2 beta outlets runs a full service day on Sail. That day includes:
  - Opening, and dine-in, takeaway, pickup and delivery orders.
  - Firing to printed kitchen tickets routed by station and tags, plus a void ticket and a reprint.
  - Scan to Order rounds sent to an open table, including one held for acceptance and one service request.
  - A split by item, a split by seat and an even split.
  - Mixed-tender payments that include card tenders, and cash with rounding turned on.
  - Automatic and manual pricing rules: the service charge, a category discount, a customer-group minimum-spend discount, the service-charge waiver, and a discount that needs a manager override.
  - A void, a full refund, a partial refund by line and a partial refund by amount. Each produces a refund receipt, and at least one refund against an invoiced check produces a credit note.
  - A shift close.
- **Print failure drills (on staging, then at each beta outlet before go-live):**
  - **Printer unplugged mid-service:** the POS alerts within 10 s, the jobs reroute to the backup printer, and no ticket is lost.
  - **Relay restarted:** queued jobs print after it reconnects.
  - **Relay replaced** with the spare device: it is paired and printing within 15 minutes.
- **Reconciliation:** the Z-report reconciles to the counted cash, including rounding. Its card total matches the terminal's end-of-day total, checked by hand.
- **Pricing reference set:** totals, adjustments, split allocations and refund reversals match a hand-calculated reference set of at least 150 orders. The set covers every rule type and condition, caps, stacking, the freeze after first payment, prices per order type, BCRS, both tax modes, rounding, splits and partial refunds. Checks always add up to their order to the cent.
- **Legacy import:** the CSV import of both beta brands is complete, with no manual re-keying of menu items.
- **Performance:**
  - p95 API latency is under 300 ms from Singapore, with Fly.io deployed in `sin` and Supabase in `ap-southeast-1`.
  - p95 time from firing to a printed kitchen ticket is under 3 s.
  - A guest's QR round reaches the POS within 2 s.

## 10. Backend decision

**Decision (confirmed after reviewing Launchpad, 29 Oct 2026): Node.js with Hono and Drizzle on Fly.io (`sin`), and Next.js on Vercel, using Launchpad's architecture as the template.**

Performance does not decide it: either stack easily handles 11 outlets. Reviewing Launchpad strengthens the case for Node:
- **The `shared` package.** Launchpad's `shared` package of zod schemas is where Sail's code for the server and the iPad would live together:
  - the pricing pipeline, split allocation and refund reversal, and
  - the ESC/POS renderer.

  The print relay is a Node client of the same API.
- **Infrastructure.** Its request and RLS pipeline, SSE live updates, migration discipline and deploy pipeline cover most of Sail's infrastructure.
- **Recommendations.** Its engineer's "do differently" list matches what Sail needed anyway: OpenAPI, staging, and a session connection from day one.

Choosing FastAPI would mean re-creating every one of these patterns in Python.

### 10.1 Condition 1 check: can Launchpad be reused as-is?

**Partly. It is a template, not something to copy unchanged.** Sail reuses Launchpad's patterns and makes the changes below. These changes are either recommended by Launchpad's own engineer or required because Sail handles money and printing. The print relay is the only new runtime.

| Launchpad today | Sail | Why |
|-|-|-|
| Zod `validate()` middleware, no OpenAPI, hand-written `lib/*-api.ts` clients | `@hono/zod-openapi` routes. The spec is committed and checked in CI. Web and relay clients are **generated from the spec** with `openapi-typescript` and `openapi-fetch`, keeping Launchpad's `lib/api.ts` wrapper (30 s timeout, typed `ApiError`). | The OpenAPI contract for the future Swift app (condition 2) |
| postgres.js on the 6543 transaction pooler | Same, with **`prepare: false`** | Prepared statements break on the transaction pooler (Launchpad's own recommendation) |
| A 5432 session connection added late, only for `LISTEN` | A 5432 session connection **from day one**, for `LISTEN`, session-level advisory locks and migrations | Launchpad's own recommendation. Transaction-level locks (`pg_advisory_xact_lock`, `SELECT … FOR UPDATE` on the outlet's sequence row and on document sequences) stay on 6543. |
| Migrations run on `main` and go straight to prod. No staging. | A **staging database** (a Supabase branch) plus a staging Fly app and a staging relay with a test printer. On merge to `main`: migrate staging, then deploy staging. Prod requires a manual approval or tag: migrate prod, deploy, then poll `/health`. | Sail handles money and runs during trading hours. Staging is also needed for the SSE and print failure drills. |
| `tsx src/index.ts --role=X` in prod | **Compile to JS** (`tsc` or `tsup`) and run `node dist/index.js --role=X`. Same single image with role flags. The relay is built the same way into its own small image. | Launchpad's own recommendation |
| Git-subdirectory private dependencies; several pnpm overrides and patches | Publish shared packages; keep pnpm overrides to a minimum. Inherit only the `postgres@3.4.8` socket-write patch, if the version still needs it. | Launchpad's own recommendation |
| Auth: Supabase JWT plus Passport SSO | Plus **station tokens + PIN sessions**, **guest tokens**, **relay tokens** and single-use **override grants**. Each maps onto the same `set_config` + `SET LOCAL ROLE` pipeline. Adds new `app_guest` and `app_relay` roles. | POS, QR and relay principals have no counterpart in Launchpad. This is the largest piece of new work in the request pipeline. |
| Fly concurrency soft 50 / hard 90; process groups `app`, `worker`, `collab` | Process groups `app` (API + SSE) and `worker`. The worker runs legacy CSV imports, materialised-view refreshes, guest-session expiry, re-queuing of stale print claims, relay-heartbeat alerts and scheduled rule activation. Concurrency is sized for open SSE connections (type `connections`; start at soft 200 / hard 400 and load-test). `min_machines_running = 2`, with auto-stop off. No `collab` group. | SSE streams (stations, relays, guests) count toward concurrency. Auto-stop would cut tills and printers mid-service. |
| Admission gate TX_MAX 6, queue 64, then 503 | Same gate. **Long jobs never run in request transactions:** imports go to the worker, and reports read materialised views. Pricing runs in memory inside the request transaction. | A 503 at the till is worse than a slow report |
| Vitest; RLS replay harness in Docker Postgres; no standing test database | Same, plus four additions: the **pricing reference set** and property tests in `shared`, RLS replay cases for `app_guest` and `app_relay`, ESC/POS golden-file tests for the templates, and SSE and print failure drills on staging | Money and service correctness (section 9) |
| Next.js App Router, route groups `(auth)/(ops)/(public)` | Workspace packages `server`, `web` (route groups `(auth)/(pos)/(backoffice)`), **`guest`** (a separate Next.js app and Vercel project, on its own subdomain), **`relay`** (a Node service, shipped as a Docker image for the outlet devices) and `shared` | Smaller bundle for phones, anonymous traffic kept apart from staff apps, and the relay kept apart from the API |
| Secrets as listed in Launchpad's summary | Same names where they apply, plus `LISTEN_DATABASE_URL` (5432), `STATION_TOKEN_SECRET`, `GUEST_TOKEN_SECRET`, `RELAY_TOKEN_SECRET`, `STAGING_DATABASE_URL` in GitHub, and a separate set of Vercel environment variables for the `guest` project. Relay devices hold only their own relay token. | New token types and staging |

**Still unknown in Launchpad** (none of these change the decision):
- **Observability:** the summary does not mention logging, metrics or alerting. Sail needs alerts on 503s, SSE connection counts, failed or late print jobs and missing relay heartbeats. We should copy whatever Launchpad uses, or agree on a choice.
- **Backups and point-in-time recovery** on the Supabase plan.
- **Release-time policy.** Launchpad deploys whenever `main` changes. Sail needs a no-deploys-during-service rule.
- **Device fleet:** Launchpad has no on-site devices. Pinned automatic updates for the relay image are new, and need a simple rollout and rollback procedure.

### 10.2 Conditions

These apply whichever stack we use; where a condition is stack-specific, it says so.
1. **Launchpad template.** Met, with the changes in section 10.1. Those changes are now part of the plan, not open conditions.
2. **OpenAPI-first contract.** Routes are defined with `@hono/zod-openapi`. The generated spec is committed to the repo, and CI fails on any spec change nobody has reviewed. The web clients, the relay client and the future Swift client are all generated from the spec. No client gets endpoints or behaviour that are missing from it.
3. **Server-authoritative events and jobs.**
   - Every station's view comes from the per-outlet sequenced event log.
   - Every printed ticket comes from the durable print-job queue.
   - SSE fed by `pg_notify`, Launchpad's pattern, only signals that something changed. Catch-up covers every missed or out-of-order notification (section 7.1, rule 7).
4. **Request pipeline and RLS (Launchpad's pattern):**
   - Each request runs in one transaction behind the admission gate, using `set_config('app.current_*')` and `SET LOCAL ROLE`.
   - RLS is the **primary** guard for tenancy and outlet scoping. The API layer enforces roles, overrides and business rules on top.
   - There is no PostgREST from browsers, and Supabase is used for Auth and Storage only.
   - Routes that opt out of RLS are listed and covered by a test.
5. **Migrations (Launchpad's discipline):**
   - Always use `drizzle-kit generate`. For RLS, grants, triggers and seeds, replace the generated SQL with hand-written SQL, either through Launchpad's no-op-edit workflow or `drizzle-kit generate --custom`. This covers:
     - the `pg_notify` triggers,
     - the adjustment, split and refund invariants,
     - the document sequences, and
     - the seeded pricing rules.
   - `db:migrate` runs a drift check, then the migration, then another drift check.
   - Migrations only move forward. They run against **staging first**, then prod.
   - Never run `drizzle-kit push` against shared environments.
6. **Data work stays in SQL, and Python is allowed beside the core.** Z-reports, product mix and sales reports are Postgres views and materialised views. Python (polars or pandas) may be used for:
   - One-off reconciliation scripts, including comparing Sail with the current POS during the beta.
   - Later BI or AI services.

   These Python tools read the database or call the API; they never own the schema or run migrations.
7. **Team skills.** If the people building the core are clearly stronger in Python than in TypeScript, the fallback is FastAPI + Alembic. That fallback is now weaker than before, because it would give up every pattern in section 10.1 and the shared pricing and rendering code.
