# Pricing pipeline semantics

Status: v0.2, 4 Nov 2026. This note records every interpretation decision made while building the pricing engine in `packages/shared/src/pricing`. Each decision is encoded as a reference case (`packages/shared/src/pricing/reference`) or a unit test (`engine.test.ts`). The scope doc (§4.8) is the authority on *what* the pipeline does; this note settles the questions the scope doc leaves open. Items marked **business choice** need Phil's or Finance's confirmation; the engine is built so that changing them is a one-line change plus new reference cases.

## 1. The function

```ts
price(order, rules, context) → { lines, adjustments, totals, trace, warnings, pricing_status }
```

- Pure: no I/O, no clock. `context.now` is the evaluation time.
- Integer cents everywhere. Percentages are basis points (1000 = 10%).
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
- A manual rule can **switch off** fees for the order (`disables.rule_ids` / `disables.report_classes`). The seeded service-charge waiver disables the `service_charge` reporting class and is recorded as a zero-amount adjustment so the audit trail shows who waived it and why.

### Step 5: GST
- **Exclusive** mode: GST on each line's net amount, and on each GST-applicable fee amount per line, each rounded half up. The order's GST is the sum of these per-line figures (not GST of the total), so the receipt's GST line equals the sum of its parts.
- **Inclusive** mode: every amount, including fees, is GST-inclusive. The GST inside an amount is `amount × rate / (1 + rate)`, rounded half up. `totals.total = net_subtotal + fee_total` and GST is reported, not added. **Business choice:** whether the service charge in inclusive mode should be computed on GST-inclusive prices (as built) or on the GST-exclusive portion.
- Discount adjustments carry `gst_amount = 0`; their tax effect is already in the line's lower net amount. Fee adjustments carry their own GST per line.

### Step 6: caps
- A cap limits a rule's total for the order. It is applied inside the rule's own computation (steps 2–4), before GST, with the reduction spread back across that rule's lines by largest remainder using the uncapped line amounts as weights. `capped: true` is set on the adjustment.

### Step 7: rounding
- Largest remainder per rule; ties go to earlier lines (input order). Every rule's line amounts sum to its total (property-tested).

## 3. Conditions
- All listed conditions must hold. Lists that are absent impose no condition; an empty `customer_group_ids` list also imposes none.
- `active_from` is inclusive, `active_to` exclusive.
- **Minimum spend is measured on undiscounted base amounts** (`scoped`: the lines in the rule's scope after exclusions; `order`: every line). **Business choice.** Rationale: eligibility then does not flip because of another discount's priority, which the scope doc lists as a key risk. The alternative (measure after higher-priority discounts) is a one-line change in `conditionsHold`.
- Customer groups match when the order's customer is in **any** of the listed groups.
- Category scope matches a line's category **or its parent** (two-level tree). Exclusions win over scope, and also match on the parent category.

## 4. Manual rules
- A manual rule applies only when the order carries a **manual application** for it. Several applications of the same rule are allowed (for example "% off item" on two different lines); each becomes its own adjustment, evaluated in `application_id` order at the rule's priority.
- `line_ids` on an application intersects with the rule's scope.
- Conditions still apply to manual rules (a dine-in-only manual rule cannot be applied to a takeaway).
- Role, override and reason requirements are enforced by the server, not the engine; the engine passes `applied_by`, `approved_by`, `override_id` and `reason` through to the adjustment.

## 5. Freeze at first payment
- The **freezable** rules are order-level discounts, any rule with a minimum-spend condition (a fee with a minimum spend is allowed but flagged by validation), and **fixed-per-order fees** (Beta v1 review: a per-order amount spread across lines would otherwise move onto paid lines when a line is added later; reference case R153).
- `freezeFrom(result, rules)` extracts the freezable adjustments from a live result; the server stores them at the first payment (v0.6).
- With `context.frozen` set:
  - a freezable rule that **was** applied at the freeze is re-emitted with its stored per-line amounts (lines that no longer exist are dropped), marked `frozen: true`;
  - a freezable rule that **was not** applied stays off, even if its conditions now hold;
  - lines added after the freeze receive line-level rules only (minus any with minimum spend);
  - fees recompute on the current discounted amounts, so a frozen discount keeps a paid check stable.
- `pricing_status` is `frozen` whenever a frozen context is passed.
- When every line a frozen rule was stored on has since been removed, the frozen adjustment is still re-emitted, with no lines and a total of 0, so the bill keeps its audit trail of what was applied at the first payment (reference case R151).

### 5.1 Paid bills (server, not the engine)
The engine prices whatever lines it is given. The server (`repriceOrder`) never gives it a line that sits on a **paid bill**: those lines keep their stored amounts and their stored share of every adjustment, the engine runs on the unpaid lines only, and the two halves are merged (a rule that touches both keeps one adjustment row). A capped rule is passed the cap **left** after the paid lines' share, so the cap still holds for the whole order. This is what makes "a paid bill never changes" true whatever happens to the rest of the order (a line added, a customer attached, a scheduled rule switching on), and it is why an item discount aimed at a paid line, a quantity change on a paid line, or removing a manual rule that has an amount on a paid line are refused with `check_locked_by_payment` instead of failing at commit. Covered by `packages/server/test/review.test.ts`.

## 6. Output invariants (all property-tested)
1. Every adjustment's line amounts sum to its total; the same for GST.
2. `|total| ≤ cap` for every capped rule.
3. `net_amount ≥ 0` for every line; `net = base + discounts`.
4. An uncapped percent fee equals the percentage of each eligible line's net amount (no compounding).
5. `Σ line totals = totals.total`; `net_subtotal = subtotal + discount_total`; exclusive: `total = net_subtotal + fee_total + gst_total`; inclusive: `total = net_subtotal + fee_total`.
6. Rule order and repeated evaluation do not change the result.
7. Freezing a live result and re-pricing the same lines reproduces the same totals and lines.

## 7. Open business choices to confirm
| # | Choice | Built as | Alternative |
|-|-|-|-|
| 1 | Minimum spend basis | Undiscounted amounts | After higher-priority discounts |
| 2 | Service charge in inclusive mode | Percent of GST-inclusive discounted prices; fee is GST-inclusive | Percent of the GST-exclusive portion |
| 3 | Exclusive blocking | Blocks everything evaluated after it on its lines | Only lower-priority rules within the same step |
| 4 | "% off bill" preset level | Order-level (frozen at first payment; new lines excluded) | Line-level (new lines also discounted) |
| 5 | Zero-amount manual applications | Recorded as zero adjustments (audit) | Dropped |
