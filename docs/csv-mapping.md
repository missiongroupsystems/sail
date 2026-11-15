# CSV import

The importer (`packages/server/src/services/importer.ts`) loads data exported from another system as CSV. It is one-way and safe to re-run. Each import job carries a **mapping** from Sail's field names (below) to the columns in your files, so a new export format needs no code change.

## How an import runs

1. An Admin uploads one or more CSV files with a mapping (`POST /v1/imports`, `dry_run: true`). Each file names its **entity** and maps Sail field → their column name. Missing fields can take a `defaults` value.
2. The worker runs the job: files are processed in dependency order (brands → outlets → categories → products → modifier groups → modifier options → menus → sections → items → areas → tables → tender types → void reasons → staff → customers → layouts). Rows are matched by **`legacy_id`** (or **SKU** for products, **mobile** for customers) and classified as *create*, *update*, *unchanged* or *rejected (with a reason)*. A dry run rolls everything back and stores the report.
3. The Admin reviews the report (counts per entity, every rejected row with its reason and data) in the back office or via `GET /v1/imports/{id}`, fixes the export or mapping, and re-runs. When satisfied, `POST /v1/imports/{id}/apply` queues the same files for real.
4. Re-running an unchanged export produces zero creates and updates. Re-running after an edit updates only the changed rows.

Values: prices are in the merchant's currency with its own decimals and `.` as the decimal mark (`16.00` EUR, `1600` JPY, `1.600` KWD); a currency symbol is ignored, `,` may only group thousands, and `1600c` is already in minor units. A price cell that is not an amount (`0,50`, `abc`) or is above the register's largest amount refuses its row with the reason in the report; a blank `price_override` means the modifier product's own price. CSV files are a machine format, so they use `.` and Latin digits whatever the merchant's locale; amounts typed by people go through `parseAmount` (pricing-semantics §8). Booleans accept `1/true/yes/y`. Lists (tags, outlet IDs) are separated by `;` or `|`. References use the referenced row's `legacy_id` (or SKU for products).

## Fields by entity

| Entity | Required | Optional | Matched by |
|-|-|-|-|
| `brands` | `name` | `legacy_id`, `accent_color` (hex) | `legacy_id`, else `name` |
| `outlets` | `name` | `legacy_id`, `address`, `phone`, `business_registration_no`, `tax_registration_no`, `business_day_cutoff` (HH:MM) | `legacy_id`, else `name` |
| `categories` | `name` | `legacy_id`, `parent_legacy_id` (parents must appear first), `sort` | `legacy_id`, else `name` |
| `products` | `name`, `price`, and `sku` or `legacy_id` | `kind` (`product`/`component`), `description`, `category_legacy_id`, `brand_legacy_id`, `tags`, `has_deposit`, `tax_class` (a tax class name; blank is the merchant's default), `open_price`, `kitchen_name`, `archived`, `price_dine_in`, `price_takeaway`, `price_pickup`, `price_delivery` | `legacy_id` if given, else `sku` |
| `modifier_groups` | `name` | `legacy_id`, `min_select`, `max_select`, `max_per_modifier` | `legacy_id`, else `name` |
| `modifier_options` | `group_legacy_id`, and `product_legacy_id` or `product_sku` | `price_override`, `child_group_legacy_id` (2 levels max), `is_default`, `sort`, `parent_product_legacy_id`/`parent_product_sku` + `group_sort` (attaches the group to that product) | group + product |
| `menus` | `name`, `brand_legacy_id` (or `options.brand_legacy_id`) | `legacy_id` | `legacy_id`, else `name` |
| `menu_sections` | `name`, `menu_legacy_id` | `legacy_id`, `parent_legacy_id` (one level), `sort` | `legacy_id`, else `menu/name` |
| `menu_items` | `section_legacy_id`, and `product_legacy_id` or `product_sku` | `sort` | section + product |
| `areas` | `name`, `outlet_legacy_id` (or `options.outlet_legacy_id`) | `legacy_id`, `sort` | `legacy_id`, else `outlet/name` |
| `tables` | `name`, `area_legacy_id` | `legacy_id`, `seats`, `shape` (`rect`/`round`/`square`), `x`, `y`, `w`, `h` | `legacy_id`, else `area/name` |
| `tender_types` | `name` | `legacy_id`, `is_cash`, `opens_drawer`, `is_terminal`, `sort` | `legacy_id`, else `name` |
| `void_reasons` | `name` | `legacy_id`, `for_refunds`, `sort` | `legacy_id`, else `name` |
| `staff` | `name`, `role` (server/cashier/manager/finance/admin) | `legacy_id`, `email`, `pin` (6 digits), `outlet_legacy_ids`, `active` | `legacy_id`, else `email`, else `name` |
| `customers` | `name`, and `mobile` or `legacy_id` | `email`, `marketing_consent` | `legacy_id` if given, else `mobile` |
| `layouts` | `label` or `folder`, `brand_legacy_id`; one row per tile | `layout_legacy_id`, `layout_name`, `page`, `folder`, `product_legacy_id`/`product_sku`, `colour` (name or hex, mapped to the 12 tile colours), `access_level` | `layout_legacy_id` |

## Rules for deep or messy exports

- Modifier groups nested deeper than two levels are rejected with a reason; the row is listed for manual re-keying (the database also refuses depth > 2).
- Legacy tile colours are mapped to the nearest of the 12 curated colours; `options.tile_colour_map` overrides the mapping per legacy value.
- A product that exists in the export under the same SKU twice: the second row updates the first (last wins).
- Products referenced by menu items or modifier options but missing from the products file are rejected rows on the referencing file, never silently created.
