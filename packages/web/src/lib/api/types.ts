import type { ClientPathsWithMethod, MethodResponse } from "openapi-fetch";
import type { ApiClient } from "../api";
import type { paths } from "./schema";

/**
 * Response types come through openapi-fetch's `MethodResponse`, so they match what
 * `req()` returns at runtime (it widens readonly tuples). Request bodies come
 * straight from the schema.
 */
type Res<M extends "get" | "post" | "patch", P extends ClientPathsWithMethod<ApiClient, M>> = MethodResponse<ApiClient, M, P>;
type Body<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends { requestBody: infer RB } ? (RB extends { content: { "application/json": infer B } } ? B : never) : never;

export type Me = Res<"get", "/v1/me">["data"];
export type Merchant = Res<"get", "/v1/merchant">["data"];
export type MerchantSettings = Merchant["settings"];
export type MerchantSettingsPatch = Body<"/v1/merchant/settings", "patch">;

export type Brand = Res<"get", "/v1/brands">["data"][number];
export type BrandCreate = Body<"/v1/brands", "post">;
export type BrandPatch = Body<"/v1/brands/{id}", "patch">;

export type Outlet = Res<"get", "/v1/outlets">["data"][number];
export type OutletCreate = Body<"/v1/outlets", "post">;
export type OutletPatch = Body<"/v1/outlets/{id}", "patch">;
/** Hours as sent: `{ mon: [["11:00", "22:00"]], ... }`. */
export type OutletHours = NonNullable<OutletCreate["hours"]>;
/** Hours as received (tuples widened to arrays). */
export type OutletHoursRead = Outlet["hours"];

export type Station = Res<"get", "/v1/outlets/{id}/stations">["data"][number];
export type StationCreate = Body<"/v1/stations", "post">;
export type StationPatch = Body<"/v1/stations/{id}", "patch">;

export type Staff = Res<"get", "/v1/staff">["data"][number];
export type StaffCreate = Body<"/v1/staff", "post">;
export type StaffPatch = Body<"/v1/staff/{id}", "patch">;

export type AuditPage = Res<"get", "/v1/audit">;
export type AuditEntry = AuditPage["data"][number];

/* ---- v0.3 back office: catalogue, pricing, floor, orders, imports ---- */

export type Category = Res<"get", "/v1/categories">["data"][number];
export type CategoryCreate = Body<"/v1/categories", "post">;
export type CategoryPatch = Body<"/v1/categories/{id}", "patch">;

export type ProductPage = Res<"get", "/v1/products">;
export type Product = ProductPage["data"][number];
export type ProductCreate = Body<"/v1/products", "post">;
export type ProductPatch = Body<"/v1/products/{id}", "patch">;
export type PricesByOrderType = NonNullable<ProductPatch["prices_by_order_type"]>;
export type BulkPriceBody = Body<"/v1/products/bulk-price", "post">;

export type ModifierGroup = Res<"get", "/v1/modifier-groups">["data"][number];
export type ModifierOption = ModifierGroup["options"][number];
export type ModifierGroupCreate = Body<"/v1/modifier-groups", "post">;
export type ModifierGroupPatch = Body<"/v1/modifier-groups/{id}", "patch">;

export type MenuSummary = Res<"get", "/v1/menus">["data"][number];
export type Menu = Res<"get", "/v1/menus/{id}">["data"];
export type MenuSection = Menu["sections"][number];
export type MenuPatch = Body<"/v1/menus/{id}", "patch">;
export type MenuSectionInput = NonNullable<MenuPatch["sections"]>[number];
export type MenuCreate = Body<"/v1/menus", "post">;

export type AvailabilityRule = Res<"get", "/v1/availability-rules">["data"][number];
export type AvailabilityRuleCreate = Body<"/v1/availability-rules", "post">;
export type AvailabilityRulePatch = Body<"/v1/availability-rules/{id}", "patch">;

export type StockEntry = Res<"get", "/v1/outlets/{id}/stock">["data"][number];

export type ChannelLink = Res<"get", "/v1/channel-links">["data"][number];
export type ChannelLinkCreate = Body<"/v1/channel-links", "post">;
export type ChannelLinkPatch = Body<"/v1/channel-links/{id}", "patch">;

export type Area = Res<"get", "/v1/areas">["data"][number];
export type Table = Res<"get", "/v1/tables">["data"][number];
export type TableCreate = Body<"/v1/tables", "post">;
export type TablePatch = Body<"/v1/tables/{id}", "patch">;

export type TenderType = Res<"get", "/v1/tender-types">["data"][number];
export type TenderTypeCreate = Body<"/v1/tender-types", "post">;
export type VoidReason = Res<"get", "/v1/void-reasons">["data"][number];
export type VoidReasonCreate = Body<"/v1/void-reasons", "post">;

export type Customer = Res<"get", "/v1/customers">["data"][number];
export type CustomerUpsert = Body<"/v1/customers", "put">;
export type CustomerGroup = Res<"get", "/v1/customer-groups">["data"][number];

export type PricingRuleVersion = Res<"get", "/v1/pricing-rules">["data"][number];
export type PricingRuleVersionCreate = Body<"/v1/pricing-rules", "post">;
export type PricingSimulateBody = Body<"/v1/pricing/simulate", "post">;
export type PricingSimulation = Res<"post", "/v1/pricing/simulate">["data"];
export type TaxClass = Res<"get", "/v1/tax-classes">["data"][number];
export type TaxRate = TaxClass["rates"][number];
export type TaxComponent = TaxRate["components"][number];
export type TaxClassCreate = Body<"/v1/tax-classes", "post">;
export type TaxClassPatch = Body<"/v1/tax-classes/{id}", "patch">;
export type TaxRateSet = Body<"/v1/tax-classes/{id}/rates", "put">;
/** One tax component of an amount: `name` is the whole printed label ("VAT 20%"). `taxable` excludes tax in both modes. */
export type TaxBreakdown = PricingSimulation["totals"]["taxes"][number];
export type TaxAmount = Omit<TaxBreakdown, "taxable">;
export type PricingValidationWarning = Res<"post", "/v1/pricing-rules/validate">["data"]["warnings"][number];

export type ImportJob = Res<"get", "/v1/imports/{id}">["data"];
export type ImportJobSummary = Res<"get", "/v1/imports">["data"][number];
export type ImportCreate = Body<"/v1/imports", "post">;
export type ImportMapping = ImportCreate["mapping"];
export type ImportEntity = ImportMapping["files"][number]["entity"];
export type ImportReport = NonNullable<ImportJob["report"]>;

export type OutletEvent = Res<"get", "/v1/outlets/{id}/events">["data"][number];
export type PairingCode = Res<"post", "/v1/stations/{id}/pairing-code">["data"];

/**
 * The order snapshot (server services/orders.ts). The OpenAPI document types it as
 * an open object, so the shape is written out here; every amount comes from the
 * register and is shown as received.
 */
export type OrderLine = {
  id: string;
  product_id: string;
  name: string;
  kitchen_name: string | null;
  sku: string | null;
  quantity: number;
  unit_price: number;
  open_price: number | null;
  modifiers: { modifier_id: string; product_id: string; name: string; quantity: number; price: number; group_id: string }[];
  notes: string | null;
  seat_no: number | null;
  source: string;
  round_id: string | null;
  status: string;
  fire_round: number | null;
  fired_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  amounts: { base: number; discount: number; net: number; fee: number; tax: number; total: number };
  /** amounts.tax by component. */
  taxes: TaxBreakdown[];
  tax_class_id: string;
  tags: string[];
  category_id: string | null;
  sort: number;
  added_by: string | null;
  created_at: string;
};
export type OrderAdjustment = {
  id: string;
  rule_key: string;
  rule_version: number;
  name: string;
  kind: string;
  level: string;
  report_class: string;
  /** Fees only: the class the fee is taxed at, null when untaxed. */
  tax_class_id: string | null;
  total: number;
  tax_total: number;
  capped: boolean;
  frozen: boolean;
  manual_application_id: string | null;
  entered_value: number | null;
  applied_by: string | null;
  approved_by: string | null;
  reason: string | null;
  lines: { line_id: string; amount: number; tax_amount: number }[];
};
export type OrderSnapshot = {
  id: string;
  order_no: string;
  outlet_id: string;
  brand_id: string;
  channel_link_id: string;
  channel: string;
  order_type: string;
  status: string;
  version: number;
  table_id: string | null;
  pax: number | null;
  customer_id: string | null;
  customer_ref: { name?: string; mobile?: string } | null;
  delivery_address: string | null;
  delivery_notes: string | null;
  ready_by: string | null;
  notes: string | null;
  station_id: string | null;
  opened_by: { id: string | null; name: string | null };
  business_date: string;
  opened_at: string;
  first_fired_at: string | null;
  ready_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  bill_requested_at: string | null;
  round_count: number;
  pricing_status: "live" | "frozen";
  totals: { tax_mode: string; tax_rounding: string; subtotal: number; discount_total: number; fee_total: number; tax_total: number; taxes: TaxBreakdown[]; total: number };
  lines: OrderLine[];
  adjustments: OrderAdjustment[];
  manual_applications: { id: string; rule_key: string; entered_value: number | null; line_ids: string[] | null; applied_by: string | null; approved_by?: string | null; reason: string | null }[];
  checks: unknown[];
  paid_total: number;
  balance: number;
};
