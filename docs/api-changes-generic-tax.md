# API and shared-type changes: generic tax, currency and locale

Status: 12 Nov 2026, branch `feat/generic-tax`. What a front end (`packages/web`, `packages/ui`, `packages/guest`) must change after the server and `@sail/shared` stopped assuming one country. Nothing is deployed, so there are no aliases for the old names: every old name below is gone. The model behind it is in `docs/pricing-semantics.md` §8.

Start with `pnpm --filter @sail/web gen:api`, which regenerates `src/lib/api/schema.d.ts` from `packages/server/openapi.json`; the type errors it produces are this list.

## 1. Renames that apply everywhere

Apply these to field names in API responses, request bodies, print-job payloads and `@sail/shared` types. "Everywhere" means: if the old name appears as a JSON key, it is now the new one.

| Old | New | Notes |
|-|-|-|
| `gst_total` | `tax_total` | orders, checks, adjustments, pricing totals, bill documents |
| `gst_amount` | `tax_amount` | adjustment lines |
| `gst_on_net` | `tax_on_net` | priced lines (`price()`, `pricing.simulate`) |
| `gst_on_fees` | `tax_on_fees` | priced lines |
| `gst` (a number) | `tax` | line `amounts.gst`, check allocations, refund totals and lines, refund-quote lines and totals, per-adjustment maps `{ amount, gst }` → `{ amount, tax }`, Z-report `sales.gst`, sales-summary `totals.gst` |
| `gst_applicable` (boolean) | `tax_class_id` (string or null) | fee rules and adjustments: the tax class the fee is taxed at, `null` when untaxed. Discounts carry `null` and must not send one. |
| `is_bcrs` | `has_deposit` | products, compiled menu products, pricing lines, CSV import/export column |
| scope `{ "type": "bcrs" }` | `{ "type": "deposit" }` | pricing rule scope |
| `uen` (outlet) | `business_registration_no` | plus a new, separate `tax_registration_no` |
| `gstAddsToTotal` | `taxAddsToTotal` | option of `allocateLine` in `@sail/shared` |

## 2. Removed

| Removed | Use instead |
|-|-|
| `gst_bps` on merchant settings, order `totals`, bill-document `totals` and `PricingContext` | The rate is no longer one number. Show `taxes` (below) by component name; never print "GST" or a percentage of your own. |
| `formatCents(cents, { currency?, sign? })` from `@sail/shared` (defaulted to SGD, en-SG) | `formatMoney(amount, { currency, locale }, { sign? })`; both currency and locale are required. `@sail/ui` has its own `formatCents`, which needs the same treatment. |
| `percentLabel` (escpos layout) | the component's `name` |
| `DEFAULT_TIME_ZONE` (escpos) and the Asia/Singapore default of `formatTime`, `formatDate`, `formatDateTime` | pass `(iso, timeZone, locale)`, all required |
| `SEED_RULES` | `presetSeedRules(REGION_PRESETS[key], taxClassIds)` or `seedRules(options)` |
| `invoice.outlet_uen` on the stored invoice document | `business_registration` and `tax_registration` on the bill document |
| Server env `GST_BPS` | tax classes and rates per merchant |
| Defaults of `SGD`, `en-SG`, `Asia/Singapore`, a 10% service charge and a container deposit for new merchants | the region preset chosen at creation (§6) |

## 3. New fields

### Merchant settings

`GET /v1/merchant` returns these in `data.settings`; `PATCH /v1/merchant/settings` accepts them.

| Field | Type | Meaning |
|-|-|-|
| `tax_rounding` | `"per_line" \| "per_rate"` | where tax is rounded (pricing-semantics §2 step 5) |
| `currency_exponent` | integer, read only | decimals of the currency's minor unit: 0 JPY, 2 EUR, 3 KWD. Every amount in the API is an integer in minor units; display `amount / 10 ** currency_exponent`, or better `formatMoney`. |
| `locale` | BCP 47 string | format money, dates and times with it (`"de-DE"`, `"en-US"`) |
| `cash_denominations` | integer[] | notes and coins for the cash counter, largest first, in minor units; may be empty |
| `business_registration_label` | string | printed before an outlet's `business_registration_no` ("UEN", "Company reg. no.") |
| `tax_registration_label` | string | printed before an outlet's `tax_registration_no` ("GST Reg No", "VAT no.") |

`currency` can no longer change once set (PATCH with a different value is a 400 `validation`). `cash_rounding_increment` is in minor units and must be 1, 2 or 5 times a power of ten (5 = CHF 0.05, 100 = SEK 1) or null.

### Tax breakdowns

Every place that had one tax figure now also has the figure by component. Use these for receipts, bill screens and reports.

| Where | Field | Shape |
|-|-|-|
| Order snapshot `totals` | `taxes` | `{ name, bps, taxable, amount }[]` (`taxable` excludes tax in both modes) |
| Order snapshot `totals` | `tax_rounding` | as in settings, frozen when the order opened |
| Order snapshot `lines[]` | `taxes`, `tax_class_id` | `{ name, bps, taxable, amount }[]`; the class the line is taxed at |
| Order snapshot `adjustments[]` | `tax_class_id` | fees only |
| Check `totals`, `allocations[]` | `taxes` | `{ name, bps, amount }[]` |
| Refunds (`refunds.list`, `refunds.quote`, `refunds.create`) `totals` and lines | `taxes` | `{ name, bps, amount }[]` |
| `price()` / `pricing.simulate` result | `lines[].taxes`, `totals.taxes` | `{ name, bps, taxable, amount }[]` |
| Sales summary (`reports.sales_summary`) | `taxes` | `{ name, bps, taxable, amount }[]`; the CSV has `tax` rows after the totals row |
| Z report `sales` | `taxes` | `{ name, bps, taxable, amount }[]` |

An exempt line contributes no component; a zero-rated line contributes one with `amount: 0`. Print rows in the order given. In exclusive mode each component is a row before the total; in inclusive mode each is a row after the total labelled `"<name> (included)"`. The `name` is the whole label ("VAT 20%", "State sales tax"); do not add the rate.

### Products, outlets and rules

Products (`products.*`) have `tax_class_id` (uuid or null; null = the merchant's default class). The compiled menu (`menu.get`) always gives the resolved class.

Outlets have `tax_registration_no` (string or null).

A pricing rule for a fee must carry `tax_class_id` (a class id, or `null` for an untaxed fee such as a deposit); a discount body must not. Seed rule `seed:amount-off-bill` is now named "Amount off bill" (was "$ off bill").

### `@sail/shared`

Pricing inputs matter only if a front end calls `price()` itself, for example the POS preview. Each `PricingLine` needs `tax_class_id`; `PricingContext` needs `tax_rounding` and `tax_rates: { tax_class_id, outlet_id, order_type, components: { name, bps }[] }[]` instead of `gst_bps`. An order's own table is on the server only; the POS should use `orders.quote` rather than rebuild it.

Bill and ticket documents (print-job payloads, digital receipts, the escpos types) changed as follows.
- `header.time_zone` is required (it was optional with a Singapore default) and `header.locale` is new and required.
- `BillDocument.currency` (ISO 4217) is new and required.
- `BillDocument.uen` → `business_registration` and `tax_registration`, each `{ label, value }` and optional.
- `BillDocument.totals`: `gst_total` → `tax_total`, `gst_bps` → `taxes: { name, bps, amount }[]`.

Money helpers are `formatMoney`, `parseMoney(text, { currency, locale })` (throws `RangeError` on text that is not an amount in that locale, including "16.50" in de-DE), `currencyExponent(code)`, `isCurrencyCode(code)`, type `MoneyFormat`.

In splits and refunds, `LineComponents.gst: number` → `taxes: TaxAmount[]`; `AllocatedComponents` adds `tax` (their sum) and `taxes`; `RefundableLine.gst` and `refunded.gst` → `taxes`; `RefundLineResult` and `RefundQuote.totals` have `tax` and `taxes`. New helpers `sumTaxes` and `sumTaxBreakdowns` add breakdowns up by component.

## 4. New operations

| Op | Method and path | Role |
|-|-|-|
| `tax_classes.list` | `GET /v1/tax-classes[?include_archived=true]` | server; also stations and agents |
| `tax_classes.create` | `POST /v1/tax-classes` `{ id?, name, components, is_default? }` | admin |
| `tax_classes.update` | `PATCH /v1/tax-classes/{id}` `{ name?, is_default?: true, archived? }` | admin; archiving is refused (409) for the default class or one still used by a product or fee |
| `tax_rates.set` | `PUT /v1/tax-classes/{id}/rates` `{ outlet_id, order_type, components }` | admin; upserts the rate for that scope |
| `tax_rates.delete` | `DELETE /v1/tax-classes/{id}/rates/{rate_id}` | admin; the default rate (no outlet, no order type) cannot be removed (409) |

A class is `{ id, name, is_default, archived, rates: { id, outlet_id, order_type, components: { name, bps }[] }[] }`. Events: `tax_class.created`, `tax_class.updated`, `tax_rate.set`, `tax_rate.deleted`.

## 5. CSV import and export

- Products: column `is_bcrs` → `has_deposit`; new column `tax_class`, a class name matched without regard to case (blank is the default class, an unknown name is a row error). Prices are read and written with the currency's decimals ("16.00" EUR, "1600" JPY, "1.600" KWD); a value with more decimals than the currency allows is a row error. Decimals are always ".", whatever the locale, and a "," that does not group thousands ("16,50") is a row error.
- Outlets: column `uen` → `business_registration_no`; new column `tax_registration_no`.

## 6. Merchant creation

`bootstrap` (script and `bootstrapMerchant`) takes `--preset=sg|us|eu-vat|jp|blank` and `--time-zone=<IANA zone>`, both required; `--currency` and `--locale` override the preset's and are required for `blank`. A merchant without a valid time zone, currency or locale is refused. The preset creates the tax classes and rates, settings, seed rules (a service charge and deposit only where the preset has one) and tenders. `dev:local` now creates two merchants: Singapore (`admin@sail.local`) and an EU VAT café in EUR (`admin.eu@sail.local`), PIN 123456 for both.

## 7. Mechanical checklist

1. `pnpm --filter @sail/web gen:api`.
2. Apply §1 with search and replace in `packages/web/src`, `packages/ui/src` and `packages/guest/src`: `gst_total`, `gst_amount`, `gst_on_net`, `gst_on_fees`, `.gst` and `gst:` on refund, allocation and adjustment objects, `gst_applicable`, `is_bcrs`, `"bcrs"`, `uen`.
3. Delete every use of `gst_bps`; render `taxes` rows instead (§3).
4. Replace every money formatter default with the merchant's `currency` and `locale` from `GET /v1/merchant`, and every hard-coded `/ 100` or `* 100` with `currency_exponent` (or `formatMoney`/`parseMoney`).
5. Replace hard-coded `Asia/Singapore` and `en-SG` with `settings.timezone` and `settings.locale`.
6. Replace "UEN" copy with `business_registration_label` and add the tax registration field next to it on the outlet form; add the tax class picker on the product form and the fee editor (`tax_classes.list`).
7. Build the cash counter from `cash_denominations` instead of a fixed list.
8. Remove "PayNow" or "BCRS" copy; tenders come from `tender_types.list`, deposits from the deposit rule.
