import { boolean, date, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { brands, merchants, outlets, stations } from "./org.js";
import { taxClasses } from "./tax.js";

/** Catalogue, menus, channels, floor and reference lists. */

export const reportCategories = pgTable(
  "report_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    /** Two-level tree: top-level categories have a null parent. */
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    sort: integer("sort").notNull().default(0),
    legacyId: text("legacy_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [index("report_categories_merchant_idx").on(t.merchantId), uniqueIndex("report_categories_legacy_uq").on(t.merchantId, t.legacyId)],
);

export const productKindEnum = pgEnum("product_kind", ["product", "component"]);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    /** Null = shared by every brand of the merchant. */
    brandId: uuid("brand_id").references(() => brands.id),
    kind: productKindEnum("kind").notNull().default("product"),
    name: text("name").notNull(),
    sku: text("sku"),
    description: text("description"),
    /** Base price in cents. */
    price: integer("price").notNull().default(0),
    categoryId: uuid("category_id").references(() => reportCategories.id),
    /** Free-form labels: printer routing and pricing-rule scope. */
    tags: text("tags").array().notNull().default([]),
    /** Carries a deposit (a returnable container): the scope of deposit fees. */
    hasDeposit: boolean("has_deposit").notNull().default(false),
    /** Null = the merchant's default tax class. */
    taxClassId: uuid("tax_class_id").references(() => taxClasses.id),
    /** Staff may enter the price at the POS (Manager+). */
    openPrice: boolean("open_price").notNull().default(false),
    /** Kitchen ticket name override (for example a short or CJK name). */
    kitchenName: text("kitchen_name"),
    legacyId: text("legacy_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("products_merchant_idx").on(t.merchantId, t.archivedAt),
    uniqueIndex("products_sku_uq").on(t.merchantId, t.sku),
    uniqueIndex("products_legacy_uq").on(t.merchantId, t.legacyId),
    index("products_name_idx").on(t.merchantId, t.name),
    index("products_category_idx").on(t.categoryId),
  ],
);

export const orderTypeEnum = pgEnum("order_type", ["dine_in", "takeaway", "pickup", "delivery"]);

export const productPrices = pgTable(
  "product_prices",
  {
    merchantId: uuid("merchant_id").notNull(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    orderType: orderTypeEnum("order_type").notNull(),
    price: integer("price").notNull(),
  },
  (t) => [primaryKey({ columns: [t.productId, t.orderType] })],
);

export const modifierGroups = pgTable(
  "modifier_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    minSelect: integer("min_select").notNull().default(0),
    /** Null = unlimited. */
    maxSelect: integer("max_select"),
    maxPerModifier: integer("max_per_modifier").notNull().default(1),
    legacyId: text("legacy_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [index("modifier_groups_merchant_idx").on(t.merchantId), uniqueIndex("modifier_groups_legacy_uq").on(t.merchantId, t.legacyId)],
);

/** A modifier is a product. Nested groups (2 levels) hang off an option. */
export const modifierOptions = pgTable(
  "modifier_options",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => modifierGroups.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** Null = the modifier product's own price. */
    priceOverride: integer("price_override"),
    childGroupId: uuid("child_group_id").references(() => modifierGroups.id),
    isDefault: boolean("is_default").notNull().default(false),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("modifier_options_group_idx").on(t.groupId), uniqueIndex("modifier_options_uq").on(t.groupId, t.productId)],
);

export const productModifierGroups = pgTable(
  "product_modifier_groups",
  {
    merchantId: uuid("merchant_id").notNull(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => modifierGroups.id, { onDelete: "cascade" }),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.productId, t.groupId] })],
);

export const menus = pgTable(
  "menus",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    legacyId: text("legacy_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("menus_brand_idx").on(t.merchantId, t.brandId), uniqueIndex("menus_legacy_uq").on(t.merchantId, t.legacyId)],
);

export const menuSections = pgTable(
  "menu_sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull(),
    menuId: uuid("menu_id")
      .notNull()
      .references(() => menus.id, { onDelete: "cascade" }),
    /** One level of sub-sections. */
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    sort: integer("sort").notNull().default(0),
    legacyId: text("legacy_id"),
  },
  (t) => [index("menu_sections_menu_idx").on(t.menuId), uniqueIndex("menu_sections_legacy_uq").on(t.merchantId, t.legacyId)],
);

export const menuItems = pgTable(
  "menu_items",
  {
    merchantId: uuid("merchant_id").notNull(),
    menuId: uuid("menu_id")
      .notNull()
      .references(() => menus.id, { onDelete: "cascade" }),
    sectionId: uuid("section_id")
      .notNull()
      .references(() => menuSections.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.sectionId, t.productId] }), index("menu_items_menu_idx").on(t.menuId)],
);

export const availabilityTargetEnum = pgEnum("availability_target", ["product", "section"]);

/**
 * Availability: by outlet and channel, plus day-of-week and
 * time windows. A target with no rules is always available; with rules, it is
 * available when ANY rule matches.
 */
export const availabilityRules = pgTable(
  "availability_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    targetKind: availabilityTargetEnum("target_kind").notNull(),
    targetId: uuid("target_id").notNull(),
    /** Empty = every outlet. */
    outletIds: uuid("outlet_ids").array().notNull().default([]),
    /** Empty = every channel. */
    channels: text("channels").array().notNull().default([]),
    /** 0 = Sunday … 6 = Saturday. Empty = every day. */
    daysOfWeek: integer("days_of_week").array().notNull().default([]),
    startTime: text("start_time"),
    endTime: text("end_time"),
  },
  (t) => [index("availability_target_idx").on(t.targetKind, t.targetId)],
);

/** Per-outlet 86 and daily caps. */
export const stockStatus = pgTable(
  "stock_status",
  {
    merchantId: uuid("merchant_id").notNull(),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** Null = available. 'infinity' for indefinitely. */
    soldOutUntil: timestamp("sold_out_until", { withTimezone: true }),
    /** Daily cap; null = no cap. */
    dailyCap: integer("daily_cap"),
    capRemaining: integer("cap_remaining"),
    capDate: date("cap_date"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.outletId, t.productId] })],
);

export const channelTypeEnum = pgEnum("channel_type", ["pos", "scan_to_order"]);

export const channelLinks = pgTable(
  "channel_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    channel: channelTypeEnum("channel").notNull(),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    menuId: uuid("menu_id")
      .notNull()
      .references(() => menus.id),
    enabled: boolean("enabled").notNull().default(true),
    /** Scan to Order: rounds wait for staff acceptance. */
    holdOrders: boolean("hold_orders").notNull().default(true),
    /** Scan to Order: the first scan opens the table's order. Default off: staff open it when seating. */
    openOnFirstScan: boolean("open_on_first_scan").notNull().default(false),
    /** Up to 5 configurable table requests, for example ["Water", "Cutlery"]. */
    serviceRequests: jsonb("service_requests").$type<string[]>().notNull().default([]),
    serviceRequestPrinterId: uuid("service_request_printer_id"),
  },
  (t) => [uniqueIndex("channel_links_uq").on(t.channel, t.outletId, t.brandId), index("channel_links_outlet_idx").on(t.merchantId, t.outletId)],
);

export const areas = pgTable(
  "areas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull(),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sort: integer("sort").notNull().default(0),
    legacyId: text("legacy_id"),
  },
  (t) => [index("areas_outlet_idx").on(t.outletId), uniqueIndex("areas_legacy_uq").on(t.merchantId, t.legacyId)],
);

export const tables = pgTable(
  "tables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull(),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id, { onDelete: "cascade" }),
    areaId: uuid("area_id")
      .notNull()
      .references(() => areas.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    seats: integer("seats").notNull().default(4),
    shape: text("shape").notNull().default("rect"),
    /** Floor-plan position and size in grid units. */
    x: integer("x").notNull().default(0),
    y: integer("y").notNull().default(0),
    w: integer("w").notNull().default(2),
    h: integer("h").notNull().default(2),
    legacyId: text("legacy_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [index("tables_outlet_idx").on(t.outletId), uniqueIndex("tables_legacy_uq").on(t.merchantId, t.legacyId)],
);

export const tenderTypes = pgTable(
  "tender_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isCash: boolean("is_cash").notNull().default(false),
    opensDrawer: boolean("opens_drawer").notNull().default(false),
    /** Card and wallet payments taken on the standalone terminal. */
    isTerminal: boolean("is_terminal").notNull().default(false),
    /** A payment with this tender needs a Manager, or a Manager's approval (house accounts and other tenders nothing else verifies). */
    requiresApproval: boolean("requires_approval").notNull().default(false),
    /** A payment with this tender needs a reference (an account, a room, a voucher number). */
    requiresReference: boolean("requires_reference").notNull().default(false),
    /** A registered payment provider (`simulator`, ...). Null: payments are recorded by hand, as before. */
    provider: text("provider"),
    /** The provider's terminal this tender sends payments to. Set exactly when `provider` is. */
    terminalId: text("terminal_id"),
    sort: integer("sort").notNull().default(0),
    legacyId: text("legacy_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [index("tender_types_merchant_idx").on(t.merchantId), uniqueIndex("tender_types_legacy_uq").on(t.merchantId, t.legacyId)],
);

export const voidReasons = pgTable(
  "void_reasons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Reasons also offered for refunds and manual discounts. */
    forRefunds: boolean("for_refunds").notNull().default(true),
    sort: integer("sort").notNull().default(0),
    legacyId: text("legacy_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [index("void_reasons_merchant_idx").on(t.merchantId), uniqueIndex("void_reasons_legacy_uq").on(t.merchantId, t.legacyId)],
);

export const accessLevelEnum = pgEnum("access_level", ["everyone", "cashier", "manager", "admin"]);

/** POS layouts: one per brand, pages > folders > tiles. Tiles are a JSON tree per page. */
export const posLayouts = pgTable(
  "pos_layouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** [{ id, name, tiles: [{ id, kind: 'product'|'folder', product_id?, label, color, access_level, tiles?: [...] }] }] */
    pages: jsonb("pages").$type<LayoutPage[]>().notNull().default([]),
    version: integer("version").notNull().default(1),
    legacyId: text("legacy_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pos_layouts_brand_idx").on(t.merchantId, t.brandId)],
);

export type LayoutTile = {
  id: string;
  kind: "product" | "folder";
  product_id?: string;
  label: string;
  /** One of the 12 curated tile colours. */
  color: string;
  access_level: "everyone" | "cashier" | "manager" | "admin";
  tiles?: LayoutTile[];
};
export type LayoutPage = { id: string; name: string; tiles: LayoutTile[] };

export { stations };
