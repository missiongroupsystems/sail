# Configuration

Nothing in Sail's logic assumes a country. Tax, currency, locale, cash handling and time are merchant settings, filled from a region preset when the merchant is created and editable afterwards. This page lists the settings and how they interact. The pricing rules behind them are in [pricing-semantics.md](pricing-semantics.md).

## Merchant settings

Read with `GET /v1/merchant` (`data.settings`), change with `PATCH /v1/merchant/settings` (Admin), or in the back office under Settings > Merchant. Amounts are in minor units of the currency.

| Setting | Meaning |
|-|-|
| `currency` | ISO 4217 code. Fixed once the merchant exists, because every stored amount is in its minor units. |
| `currency_exponent` | Read only: decimals of the minor unit (JPY 0, EUR 2, KWD 3). |
| `locale` | BCP 47 tag used to format money, dates and times (`en-US`, `de-DE`). |
| `timezone` | IANA zone. Required; there is no default. |
| `business_day_cutoff` | `HH:MM` local time at which the business day rolls over (default `04:00`). An outlet can override it. |
| `tax_mode` | `inclusive` or `exclusive` prices, for the whole merchant. |
| `tax_rounding` | `per_line` or `per_rate` (see below). |
| `cash_rounding_increment` | Null for off, or 1, 2 or 5 times a power of ten minor units (5 = CHF 0.05, 100 = SEK 1). |
| `cash_denominations` | Notes and coins the POS cash counter offers, largest first. Empty means the counter takes a total only. |
| `cash_variance_threshold` | Closing a shift more than this far out needs a reason. |
| `business_registration_label`, `tax_registration_label` | Printed before each outlet's `business_registration_no` and `tax_registration_no` on receipts and invoices. |
| `receipt_footer`, `receipt_show_outlet_phone` | Receipt text. |
| `busy_mode_threshold` | Open orders above which the POS switches to its busy layout. |
| `kitchen_warn_minutes`, `kitchen_late_minutes` | Kitchen display: a ticket's elapsed time turns amber after the first and red after the second (defaults 8 and 15; the second must be higher, at most 240). |

## Kitchen display

Kitchen screens are set up in two places. On Printing > Printers, under Kitchen displays, add a **display destination** and give it routing the way you would a kitchen printer: include and exclude tags, order types and sources, or mark it the default to take every item no other destination matched. A destination with no tags takes everything. On Settings > Stations, add a station of kind **Kitchen display**, tick the destinations it shows, and pair a screen to it: open `/kds` on the screen and enter the code from Pair an iPad. A display needs no PIN, and several displays can show the same destination. Printers keep printing whether or not a display exists; to run a kitchen on screens only, add no kitchen printer.

The elapsed-time colours come from `kitchen_warn_minutes` and `kitchen_late_minutes` in the merchant settings (API only for now: `PATCH /v1/merchant/settings`).

## Region presets

A preset is plain data in `packages/shared/src/presets.ts`. The engine and the server never branch on which one was picked. It sets the currency, locale, a suggested time zone, tax mode and rounding, tax classes and rates, an optional service charge and deposit rule, the manual discount presets, tenders, cash denominations, the variance threshold and the registration labels.

| Key | Currency, locale | Tax | Extras |
|-|-|-|-|
| `sg` | SGD, en-SG | GST 9%, exclusive, per line | 10% dine-in service charge taxed at GST, 10-cent container deposit, PayNow tender |
| `us` | USD, en-US | State 4% + local 4.5%, exclusive, per rate; an exempt grocery class | |
| `eu-vat` | EUR, en-IE | VAT 20% standard and 10% reduced, inclusive, per rate; an exempt class | |
| `jp` | JPY, ja-JP | Consumption tax 10%, 8% for takeaway, pickup and delivery food, inclusive, per rate | |
| `blank` | You choose | One untaxed class | Cash tender only |

The rates in `us` and `eu-vat` are examples, not the law of any one state or country. Check them against your own before you trade.

The preset is chosen when the merchant is created (`bootstrap --preset=<key>`, see [self-hosting.md](self-hosting.md#create-the-first-merchant)). `--time-zone` is always required (a preset only suggests one); `--currency` and `--locale` override the preset, and `blank` needs both.

**Adding a preset.** Add the key to `REGION_PRESET_KEYS` and an entry to `REGION_PRESETS` in `presets.ts`, then run `pnpm --filter @sail/shared test`: `presets.test.ts` checks every preset: unique class codes, a default class and fee classes that exist, a known currency, denominations largest first and divisible by the rounding increment, and seed rules that parse. If the tax regime rounds or groups tax in a way no reference case covers, add cases under `packages/shared/src/pricing/reference`.

## Tax classes and rates

A **tax class** is what a product, open item or fee is ("Standard rate", "Alcohol", "Exempt"). One class per merchant is the default; a product with no class uses it. A **rate** gives the tax for a class, either everywhere (the class's default rate, which cannot be removed), at one outlet, for one order type, or both. The most specific match wins: outlet and order type, then outlet, then order type, then the default. A rate is a list of **components**, each `{ name, bps }`. The name is printed exactly as written, so it carries the rate ("VAT 20%", "State sales tax"). An empty list is exempt (nothing printed); a component at 0 bps is zero-rated (printed as 0).

Manage them in the back office under Settings > Tax classes, or through the API (Admin):

| Operation | Request |
|-|-|
| `tax_classes.list` | `GET /v1/tax-classes` |
| `tax_classes.create` | `POST /v1/tax-classes` `{ name, components, is_default? }` |
| `tax_classes.update` | `PATCH /v1/tax-classes/{id}` `{ name?, is_default?, archived? }` |
| `tax_rates.set` | `PUT /v1/tax-classes/{id}/rates` `{ outlet_id, order_type, components }` |
| `tax_rates.delete` | `DELETE /v1/tax-classes/{id}/rates/{rate_id}` |

An order stores the tax mode, rounding and rates that apply at its outlet when it opens, so a rate change never re-prices an open order.

**Rounding.** `per_line` rounds each line's tax and adds them up. `per_rate` groups the order's amounts by rate, rounds the rate's combined tax once on the group's total, splits it between the components by largest remainder, then spreads each component across the lines. Most VAT and consumption-tax invoices round per rate; `per_line` exists because some receipts have always been printed that way. The two can differ by a unit per rate on the same order.

### Example 1: US sales tax, exclusive, two components

The `us` preset creates a "Prepared food" class whose default rate has two components:

```json
{ "outlet_id": null, "order_type": null, "components": [{ "name": "State sales tax", "bps": 400 }, { "name": "Local sales tax", "bps": 450 }] }
```

A burger at 12.99, two fries at 3.49 and a soda at 2.49 (reference case R154, `cases-regions.ts`):

| | Amount |
|-|-|
| Subtotal | 22.46 |
| State sales tax (4% of 22.46 = 0.8984) | 0.90 |
| Local sales tax (4.5% of 22.46 = 1.0107) | 1.01 |
| Total | 24.37 |

Per line, the local tax would round to 0.58 + 0.31 + 0.11 = 1.00, a cent short of 4.5% of the order, which is why the preset rounds per rate. An outlet in a city with a different local rate gets its own rate on the same class:

```json
{ "outlet_id": "<outlet id>", "order_type": null, "components": [{ "name": "State sales tax", "bps": 400 }, { "name": "Local sales tax", "bps": 500 }] }
```

### Example 2: EU VAT, inclusive, two rates

The `eu-vat` preset creates "Standard rate" (VAT 20%) and "Reduced rate" (VAT 10%) classes, with prices tax-inclusive. Two glasses of wine at 9.00 and a water at 3.50 are standard-rated, a pasta at 14.50 is reduced-rated, and a 10% off the bill discount applies (reference case R155):

| | Amount |
|-|-|
| Wine 2 x 9.00, water 3.50, pasta 14.50 | 36.00 |
| 10% off the bill | -3.60 |
| Total | 32.40 |
| VAT 20% (included): 20/120 of 19.35 (16.20 + 3.15) = 3.225 | 3.23 |
| VAT 10% (included): 10/110 of 13.05 = 1.186 | 1.19 |

In inclusive mode the total is what the guest pays and each component is printed after it as "(included)". The discount lowers the taxed amount of the lines it reduces, so VAT is worked out on the discounted prices. A fee such as a service charge names its own tax class (`tax_class_id`, or null for an untaxed fee such as a deposit); it does not follow the rate of the line it sits on.

Japan's takeaway rate is the same mechanism with an order type: the `jp` preset's food class has a 10% default rate and an 8% rate for `takeaway`, `pickup` and `delivery`.

## Currency and locale

Every amount in the API is an integer in minor units. To display one, divide by `10 ** currency_exponent`, or use `formatMoney(amount, { currency, locale })` from `@sail/shared`. Neither currency nor locale has a default anywhere: the web apps read them from the merchant settings, guest sessions and digital receipts carry them (`settings` on the session, `currency` and `header.locale` on the bill document), and printed tickets use the merchant's locale and time zone. CSV imports read prices with the currency's decimals and `.` as the decimal mark ([csv-mapping.md](csv-mapping.md)).

## Cash rounding and denominations

Cash rounding applies only when a tender with `is_cash` settles the rest of a bill: the balance rounds to the nearest increment, halves up, and the difference is stored on the payment as its own figure. It never changes tax or line amounts and never applies to card or other tenders. Cash refunds round the same way. Expected cash at shift close includes the rounding.

A cash tip is part of the cash handed over, never part of the change: change = tendered − bill − rounding − tip. The tip stays in the drawer, so expected cash includes cash tips, and with cash rounding on a cash tip must be a whole number of rounding steps ([pricing-semantics.md](pricing-semantics.md#9-register-rules-around-the-bill-server-not-the-engine)).

`cash_denominations` drives the POS cash counter at shift open and close. When the counted cash differs from the expected cash by more than `cash_variance_threshold`, `shifts.close` refuses to close without a reason.

## Tenders and approvals

Tenders are rows in `tender_types` (Settings > Tenders, or `/v1/tender-types`):

| Flag | Effect |
|-|-|
| `is_cash` | Cash rounding applies; counts towards expected cash |
| `opens_drawer` | Stored and imported, but not used by any logic yet |
| `is_terminal` | Taken on a standalone card terminal and recorded by hand; Sail never talks to the terminal |
| `requires_approval` | A Cashier needs a Manager, or a Manager's PIN for that exact payment and reference. On by default for a tender that is neither cash nor a terminal (a house account) |
| `requires_reference` | A payment without a reference is refused |

Who may do what is the fixed matrix in `packages/shared/src/roles.ts`, not a setting. A few entries: recording a payment needs Cashier+; refunds, reopening an order, open prices and voiding a sent item need Manager+ or a manager approval; editing configuration, staff and pricing rules needs Admin. A manual pricing rule (a discount or waiver staff apply) carries its own `min_role`, whether a manager may approve it for a lower role (`override_allowed`) and whether a reason is required (`reason_required`).

## Time zone and business day

Every "today" in the register comes from the business date, never the calendar date: daily stock caps, sold out for today, shift and day close, Z-reports, refund dating, reopen and the print-health report. The business date is the local date in `timezone`, shifted back by `business_day_cutoff`, so with a 04:00 cutoff a sale at 01:30 belongs to the day before. A cutoff that falls in a daylight-saving gap ends the day at the first valid instant after it; one in an overlap ends it at its first occurrence. Pricing-rule dates and other date inputs in the back office are entered in the merchant's time zone. Outlet opening hours (`hours`) and the Service theme start time (`service_theme_from`) are per outlet.
