# Pricing pipeline semantics

Every interpretation decision in the pricing engine (`packages/shared/src/pricing`). Each one is encoded as a reference case (`packages/shared/src/pricing/reference`) or a unit test (`engine.test.ts`). Decisions marked **choice** could reasonably go the other way; they are listed in §7, and changing one is a small change to the engine plus new reference cases.

## 1. The function

```ts
price(order, rules, context) → { lines, adjustments, totals, trace, warnings, pricing_status }
```

- Pure: no I/O, no clock. `context.now` is the evaluation time.
- Integer minor units of the merchant's currency everywhere (cents, yen, fils: the exponent comes from ISO 4217 via `currencyExponent`). Percentages are basis points (1000 = 10%).
- Inputs are validated with zod; a malformed input throws. A business problem (for example an open value outside its range) never throws: the rule is skipped and a warning is returned, because the server validates manual applications before accepting them (`validateManualApplication`).
- Deterministic: rules are sorted by `(priority, id)`; manual applications by `application_id`. Shuffling the input order gives a byte-identical result (property-tested).

## 2. Step-by-step decisions

### Step 1: base prices
- `unit = open_price ?? prices.by_order_type[order_type] ?? prices.base`.
- Modifier prices are resolved by the caller (group price override, else the modifier product's price) and passed in; the engine adds them per unit, then multiplies by quantity.
- Lines with quantity 0 are carried through with zero amounts and are never eligible for any rule.

### Step 2: line-level discounts
- A discount's **level** is explicit (`level`), defaulting to `line`. `fixed_per_order` must be `order`; `fixed_per_unit` must be `line`; `percent` may be either. The seeded "% off bill" is `order`, "% off item", "Staff meal" and "Manager comp" are `line`.
- A percent line discount applies to each eligible line's **running amount** (after higher-priority discounts). A fixed-per-unit discount applies `value × quantity`, capped at the line's running amount, so no discount takes a line below zero.
- **Exclusive** stops every discount evaluated after it (line-level with a lower priority, and all order-level discounts, because step 3 runs after step 2) on the lines it was eligible for. The blocked set is the rule's eligible lines, whether or not the computed amount on a line was zero. Fees are not discounts and are never blocked.

### Step 3: order-level discounts
- The pool is the sum of the running amounts of the eligible lines. `fixed_per_order` takes `min(value, pool)`; `percent` takes the percentage of the pool. The total is spread across the eligible lines in proportion to their running amounts with the largest-remainder method, which guarantees no line goes below zero and the line amounts add up exactly.

### Step 4: fees
- Fees apply in priority order to their scoped lines (exclusions honoured). A percent fee is the percentage of each line's **discounted** amount. `fixed_per_unit` is `value × quantity`. `fixed_per_order` is spread across the scoped lines in proportion to their discounted amounts (evenly if they are all zero).
- **Fees never compound**: a fee is never calculated on another fee (property-tested).
- A fee names the tax class it is taxed at (`tax_class_id`), or `null` for an untaxed fee such as a container deposit. A discount never names one: it lowers the taxed amount of the lines it reduces.
- A manual rule can **switch off** fees for the order (`disables.rule_ids` / `disables.report_classes`). The seeded service-charge waiver disables the `service_charge` reporting class and is recorded as a zero-amount adjustment so the audit trail shows who waived it and why.

### Step 5: tax
- Every taxed amount is an item: each line's net amount, taxed at the line's class, and each fee amount on a line, taxed at the fee's class. The rate for a class is resolved from the order's outlet and order type (§8).
- A rate is rounded once at its combined bps and then split between its components by largest remainder, weighted by their bps, so State 4% + Local 4.5% on 1013 is 86 (40 + 46), never 41 + 46 (R162).
- **Exclusive** mode: a rate's tax is `amount × combined bps / 10000`, rounded half up. `total = net_subtotal + fee_total + tax_total`.
- **Inclusive** mode: every amount, including fees, is tax-inclusive. A rate's tax inside an amount is `amount × combined bps / (10000 + combined bps)`, rounded half up. `totals.total = net_subtotal + fee_total` and tax is reported, not added. **Choice:** whether the service charge in inclusive mode should be computed on tax-inclusive prices (as built) or on the tax-exclusive portion.
- **Rounding** is a merchant setting (`tax_rounding`):
  - `per_line`: each item's tax is rounded on its own, and the order's tax is the sum of these per-line figures. The `sg` preset uses it, and reference cases R001 to R153 are priced this way.
  - `per_rate`: items are grouped by their rate (the same list of components), the rate is rounded once on the group's total, and each component is spread back across the group's items with the largest-remainder method, weighted by the items' amounts. EU and Japanese invoices round once per rate; most US states accept rounding on the order. Reference cases R154 to R162. A component that appears in two rates (State 4% in both a food rate and an alcohol rate) is rounded with each rate, so its row on the receipt is the sum of two roundings.
  - The two modes give the same answer for a single item, but not in general: three 5-cent items at 9% are 0 + 0 + 0 per line and round(1.35) = 1 per rate. Rounding per rate therefore cannot reproduce the per-line amounts of R001 to R153 (27 of them change by a cent when switched to `per_rate`), which is why the `sg` preset keeps `per_line` and every other preset uses `per_rate`.
- A bill that is already paid keeps its stored tax (§5.1), so after a partial payment `per_rate` rounds the unpaid lines' groups on their own: the order's tax is then the paid lines' stored tax plus the unpaid lines' rounded groups, not one rounding over the whole order, and can differ from it by a cent per rate. Each half still adds up exactly. For the same reason, bills split from a `per_rate` order carry their lines' share of the order's rounding, so two identical bills can differ by a cent.
- Discount adjustments carry `tax_amount = 0`; their tax effect is already in the line's lower net amount. Fee adjustments carry their own tax per line.
- Each priced line reports `tax_on_net`, `tax_on_fees` and `taxes` (its tax by component, with the amount each was charged on). `totals.taxes` is the order's breakdown: the sum of the lines' by component (name and rate), so the receipt's tax lines add up to its parts. An exempt line adds nothing to it; a zero-rated line adds its component with an amount of 0.

### Step 6: caps
- A cap limits a rule's total for the order. It is applied inside the rule's own computation (steps 2 to 4), before tax, with the reduction spread back across that rule's lines by largest remainder using the uncapped line amounts as weights. `capped: true` is set on the adjustment.

### Step 7: rounding
- Largest remainder per rule; ties go to earlier lines (input order). Every rule's line amounts sum to its total (property-tested).

## 3. Conditions
- All listed conditions must hold. Lists that are absent impose no condition; an empty `customer_group_ids` list also imposes none.
- `active_from` is inclusive, `active_to` exclusive.
- **Minimum spend is measured on undiscounted base amounts** (`scoped`: the lines in the rule's scope after exclusions; `order`: every line). **Choice.** Rationale: eligibility then does not flip because of another discount's priority, which would make totals jump as lines change. The alternative (measure after higher-priority discounts) is a one-line change in `conditionsHold`.
- Customer groups match when the order's customer is in **any** of the listed groups.
- Category scope matches a line's category **or its parent** (two-level tree). Exclusions win over scope, and also match on the parent category.

## 4. Manual rules
- A manual rule applies only when the order carries a **manual application** for it. Several applications of the same rule are allowed (for example "% off item" on two different lines); each becomes its own adjustment, evaluated in `application_id` order at the rule's priority.
- `line_ids` on an application intersects with the rule's scope.
- Conditions still apply to manual rules (a dine-in-only manual rule cannot be applied to a takeaway).
- Role, override and reason requirements are enforced by the server, not the engine; the engine passes `applied_by`, `approved_by`, `override_id` and `reason` through to the adjustment.

## 5. Freeze at first payment
- The **freezable** rules are order-level discounts, any rule with a minimum-spend condition (a fee with a minimum spend is allowed but flagged by validation), and **fixed-per-order fees** (a per-order amount spread across lines would otherwise move onto paid lines when a line is added later; reference case R153).
- `freezeFrom(result, rules)` extracts the freezable adjustments from a live result; the server stores them at the first payment.
- With `context.frozen` set:
  - a freezable rule that **was** applied at the freeze is re-emitted with its stored per-line amounts (lines that no longer exist are dropped), marked `frozen: true`;
  - a frozen **discount** takes at most what the line is now worth: on a line cut in quantity, comped or discounted since the freeze, its share is capped at the line's running amount, and a line an exclusive discount took since the freeze gets none of it. The stored amounts stay as they were, so a line that grows back gets its share back. No line, bill or tax component goes below zero;
  - a freezable rule that **was not** applied stays off, even if its conditions now hold;
  - lines added after the freeze receive line-level rules only (minus any with minimum spend);
  - fees recompute on the current discounted amounts, so a frozen discount keeps a paid check stable.
- `pricing_status` is `frozen` whenever a frozen context is passed.
- When every line a frozen rule was stored on has since been removed, the frozen adjustment is still re-emitted, with no lines and a total of 0, so the bill keeps its audit trail of what was applied at the first payment (reference case R151).

### 5.1 Paid bills (server, not the engine)
The engine prices whatever lines it is given. The server (`repriceOrder`) never gives it a line that sits on a **paid bill**: those lines keep their stored amounts and their stored share of every adjustment, the engine runs on the unpaid lines only, and the two halves are merged (a rule that touches both keeps one adjustment row). A capped rule is passed the cap **left** after the paid lines' share, so the cap still holds for the whole order. This is what makes "a paid bill never changes" true whatever happens to the rest of the order (a line added, a customer attached, a scheduled rule switching on), and it is why an item discount aimed at a paid line, a quantity change on a paid line, or removing a manual rule that has an amount on a paid line are refused with `check_locked_by_payment` instead of failing at commit. Covered by `packages/server/test/review.test.ts`.

A paid bill's documents (receipt, tax invoice, refund receipt) are built from what was recorded at payment: its allocations, which never change, and the adjustment rows they name. An adjustment keeps its id across re-prices (one rule version and manual application is one adjustment), and adjustments are stored in the engine's own order (line discounts, order discounts, fees; by priority and id) whether they came from the engine or were carried over from paid lines, so re-pricing the rest of the order never drops, renames or reorders a paid bill's rows (`packages/server/test/money.test.ts` compares the documents byte for byte). The "Bill 1 of 3" label counts the order's bills when the document is printed.

## 6. Output invariants (all property-tested)
1. Every adjustment's line amounts sum to its total; the same for tax.
2. `|total| ≤ cap` for every capped rule.
3. `net_amount ≥ 0` for every line; `net = base + discounts`. This holds after the freeze too, whatever happens to the unpaid lines (quantity cuts, comps, item discounts, removed or moved lines).
4. An uncapped percent fee equals the percentage of each eligible line's net amount (no compounding).
5. `Σ line totals = totals.total`; `net_subtotal = subtotal + discount_total`; exclusive: `total = net_subtotal + fee_total + tax_total`; inclusive: `total = net_subtotal + fee_total`.
6. Rule order and repeated evaluation do not change the result.
7. Freezing a live result and re-pricing the same lines reproduces the same totals and lines.
8. Per component, the lines' tax adds up to the order's (`totals.taxes`), and each line's components add up to its tax; split bills add up to the order, in total and per component. With `per_rate` in exclusive mode, each rate's order tax is the combined rate rounded once on its taxable amount.

## 7. Choices and their alternatives
| # | Choice | Built as | Alternative |
|-|-|-|-|
| 1 | Minimum spend basis | Undiscounted amounts | After higher-priority discounts |
| 2 | Service charge in inclusive mode | Percent of tax-inclusive discounted prices; fee is tax-inclusive | Percent of the tax-exclusive portion |
| 3 | Exclusive blocking | Blocks everything evaluated after it on its lines | Only lower-priority rules within the same step |
| 4 | "% off bill" preset level | Order-level (frozen at first payment; new lines excluded) | Line-level (new lines also discounted) |
| 5 | Zero-amount manual applications | Recorded as zero adjustments (audit) | Dropped |
| 6 | Outlet against order type when both have a rate | The outlet's rate wins (location decides the jurisdiction) | The order type's rate wins |
| 7 | A service charge on lines at two VAT rates | The fee has one tax class | The fee follows the rate of the line it sits on |

## 8. Tax model

The smallest model that covers a single rate (the `sg` preset's GST), US state plus local tax, Japan's 8% takeaway and 10% dine-in, and EU standard and reduced rates. How to set it up: [configuration.md](configuration.md).

**Tables** (`packages/server/src/db/schema/tax.ts`)
- `tax_classes (id, merchant_id, name, is_default, archived_at)`: what a product, open item or fee is ("Standard-rated", "Reduced rate", "Alcohol", "Exempt"). Exactly one class per merchant is the default; a product with `tax_class_id = null` uses it.
- `tax_rates (id, merchant_id, tax_class_id, outlet_id null, order_type null, components jsonb)`: the tax for a class, for every outlet and order type (both null: the class's default rate, which every class has and which cannot be removed), for one outlet, for one order type, or both. Unique on `(tax_class_id, outlet_id, order_type)` with nulls not distinct.
- `components` is a list of `{ name, bps }`. The name is printed on receipts and documents exactly as it stands ("VAT 20%", "State sales tax", "Consumption tax 8% (reduced)"). An empty list is **exempt** (nothing printed); a component of 0 bps is a **zero rate** (printed with 0).

**Resolution** (`resolveTaxRate`, in the engine): among the class's rates whose outlet is null or the order's outlet and whose order type is null or the order's, the most specific wins: outlet and order type, then outlet, then order type, then the default.

**Settings**: `merchant_settings.tax_mode` (inclusive or exclusive prices, for the whole merchant) and `merchant_settings.tax_rounding` (`per_line` or `per_rate`). When an order opens it stores `tax_mode`, `tax_rounding` and `tax_rates` (the rates that can apply at its outlet), so later rate changes never re-price an open order. If the order later needs a class it did not have (a product moved to a class created since, a new fee taxed at one), that class's current rates are added to the order's table at the next re-price; classes already there keep their rates. Lines store their resolved `tax_class_id`, `tax_amount` and `taxes`; bills, allocations and refunds store `tax` and `taxes` by component, allocated and reversed one component at a time.

**Money and locale**: amounts are integers in the minor unit of `merchant_settings.currency` (ISO 4217, fixed once the merchant exists); `currencyExponent` gives the number of decimals (0 JPY, 2 EUR, 3 KWD). `formatMoney` and `parseMoney` in `money.ts` take the currency and `merchant_settings.locale` (BCP 47) explicitly; nothing has a default. There is one parser, `parseAmount`, and every money field (the back office's `MoneyField`, the refund sheet, the merchant settings) goes through it. It reads back everything the formatters write, in every locale and currency Intl supports (property-tested, Arabic-Indic, Persian, Devanagari and Thai digits and 0, 2 and 3 decimals included). Inputs do not have to use Latin digits: an amount may be typed in the locale's own digits or in Latin ones, which every keyboard has, and in a locale whose own digits are not Latin the separators it uses with Latin digits are accepted too (in ar-KW, "٢٫١٢٥", "2٫125" and "2.125" are all 2.125 KWD). Fields show amounts in the locale's own digits. Digit groups must be the locale's ("1,00,000" is refused in en-US), and text that would read as two different amounts is refused. Amounts are stored as bigint and read as JS numbers. Every amount a request carries, and every line and order subtotal, is at most `MAX_AMOUNT` (10^12 minor units: Rp 10,000,000,000.00, or 10^12 VND); above it the request is refused with a validation error. That leaves a factor of 9,000 below 2^53 for report sums, and the engine takes amount × rate and amount × weight in BigInt, so its results are exact at that size. The choice was a JS number with these bounds rather than bigint end to end: every amount fits a number exactly, and bigint through the engine, JSON and both front ends would touch every line of arithmetic for no amount anyone can enter. `cash_rounding_increment` is in minor units (5 = CHF 0.05, 100 = SEK 1, 10 = JPY 10) and `cash_denominations` lists the notes and coins for the cash counter, also in minor units.

**Presets** (`packages/shared/src/presets.ts`) set up the classes, rates and settings when a merchant is created; see [configuration.md](configuration.md#region-presets). A preset is data: the engine and the server never branch on its key.

## 9. Register rules around the bill (server, not the engine)

- **Cash tips.** A cash tip is part of the cash the guest hands over, never part of the change: change = tendered − bill − cash rounding − tip. It stays in the drawer, so a shift's expected cash is float + cash payments + rounding + cash tips − cash refunds, and the receipt prints the tip on its own row between the rounding and the change. With cash rounding on, a cash tip must be a whole number of rounding steps, so the change can be paid.
- **Tenders nothing else verifies.** Each tender has `requires_approval` (a Cashier needs a Manager, or a Manager's PIN for that exact payment, including its reference) and `requires_reference` (refused without one). Approval is on by default for a tender that is neither cash nor a card terminal (a house account), whether a region preset, an import or the back office creates it.
- **Scan to Order with hold orders off.** A round fires at once only from the seating's first phone and from a phone staff have accepted a round from; another phone's round waits for acceptance, one tap per extra phone. Admission belongs to the order and the device: it follows the order to another table, survives a fresh scan after the session expires, and ends when the order closes. A rejected round admits nobody.

## 10. Business days, shifts and the Z-report (server, not the engine)

**What a business day contains.** Each record is dated once, when it is written, and never moves:
- An **order** is dated on the business day it opens. Its sale (gross, discounts, fees, tax by component, total) counts on that day and at the station that opened it, once it is completed.
- A **payment** or **refund** taken in a shift is dated on that shift's business day, even after the clock passes the cutoff, so a drawer counted at shift close and the day it belongs to always agree. Outside a shift (card only, see below) it is dated on the current business day.
- The **current business day** is the clock's (`businessDateFor` with the outlet's cutoff and time zone), or the next one once the clock's day has been closed early. A business day can be closed only once it has started on the clock, so dates never run more than one day ahead.

**Cash.** Cash is taken and paid out only into an open shift's drawer: a cash payment or cash refund with no shift open at the station (or outlet-wide) is refused with `no_open_shift`. Card and other tenders need no shift.

**How the Z-report reconciles to cash.** The drawer side uses payments and refunds only: `expected = float + cash payments + cash rounding + cash tips − cash refunds (with their rounding)`, and `variance = counted − expected`. A day's float and count are the sums over its shifts. The sales side is the completed orders of the day (and station). The two meet in `reconciliation`: `tenders = sales.total + paid_on_other_orders − paid_elsewhere`. `paid_on_other_orders` is what the scope took for orders that are not its completed sales: still open, part-paid, or opened on another day or station. `paid_elsewhere` is what its completed sales were paid on another day, station or shift. Payments reversed in the scope (voids, reopens) are listed under `reversals` and in the exceptions report, and count in no tender.

**Closing.** A business day closes once (a second close is refused), and only when every shift at the outlet is closed (`open_shifts`) and every order of the day is completed or cancelled (`open_orders`). After the close no order, payment, refund or shift is dated on it (an event's `business_date` and the daily sold-out counts still follow the clock; no report reads them). A payment of that day cannot be voided (`business_day_closed`), an order of that day cannot be reopened, and a correction is a refund on a later day. The Z-report stored at the close is that day's record, and the live report for the day stays equal to it.
