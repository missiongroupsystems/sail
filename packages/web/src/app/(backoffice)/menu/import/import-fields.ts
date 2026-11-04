import type { ImportEntity } from "@/lib/api/types";

/**
 * Sail's fields per entity, from docs/csv-mapping.md. The mapping in each import
 * job translates the legacy export's columns to these names, so the importer
 * needs no code change when the real exports arrive.
 */
export type ImportField = { name: string; required?: boolean; hint?: string };

export const ENTITY_ORDER: ImportEntity[] = ["brands", "outlets", "categories", "products", "modifier_groups", "modifier_options", "menus", "menu_sections", "menu_items", "areas", "tables", "tender_types", "void_reasons", "staff", "customers", "layouts"];

export const ENTITY_LABEL: Record<ImportEntity, string> = {
  brands: "Brands",
  outlets: "Outlets",
  categories: "Categories",
  products: "Products",
  modifier_groups: "Modifier groups",
  modifier_options: "Modifier options",
  menus: "Menus",
  menu_sections: "Menu sections",
  menu_items: "Menu items",
  areas: "Areas",
  tables: "Tables",
  tender_types: "Tender types",
  void_reasons: "Void reasons",
  staff: "Staff",
  customers: "Customers",
  layouts: "POS layouts",
};

const id = (hint = "Matches rows on re-runs"): ImportField => ({ name: "legacy_id", hint });

export const FIELDS: Record<ImportEntity, ImportField[]> = {
  brands: [{ name: "name", required: true }, id(), { name: "accent_color", hint: "Hex colour" }],
  outlets: [{ name: "name", required: true }, id(), { name: "address" }, { name: "phone" }, { name: "uen" }, { name: "business_day_cutoff", hint: "HH:MM" }],
  categories: [{ name: "name", required: true }, id(), { name: "parent_legacy_id", hint: "Parents must appear first" }, { name: "sort" }],
  products: [
    { name: "name", required: true },
    { name: "price", required: true, hint: "16.00, $16 or 1600c" },
    { name: "sku", hint: "Required unless legacy_id is mapped" },
    id("Required unless sku is mapped"),
    { name: "kind", hint: "product or component" },
    { name: "description" },
    { name: "category_legacy_id" },
    { name: "brand_legacy_id" },
    { name: "tags", hint: "Separated by ; or |" },
    { name: "is_bcrs", hint: "1/true/yes" },
    { name: "open_price", hint: "1/true/yes" },
    { name: "kitchen_name" },
    { name: "archived", hint: "1/true/yes" },
    { name: "price_dine_in" },
    { name: "price_takeaway" },
    { name: "price_pickup" },
    { name: "price_delivery" },
  ],
  modifier_groups: [{ name: "name", required: true }, id(), { name: "min_select" }, { name: "max_select" }, { name: "max_per_modifier" }],
  modifier_options: [
    { name: "group_legacy_id", required: true },
    { name: "product_legacy_id", hint: "Or product_sku" },
    { name: "product_sku", hint: "Or product_legacy_id" },
    { name: "price_override" },
    { name: "child_group_legacy_id", hint: "Two levels at most" },
    { name: "is_default" },
    { name: "sort" },
    { name: "parent_product_legacy_id", hint: "Attaches the group to that product" },
    { name: "parent_product_sku" },
    { name: "group_sort" },
  ],
  menus: [{ name: "name", required: true }, { name: "brand_legacy_id", hint: "Or set the brand option below" }, id()],
  menu_sections: [{ name: "name", required: true }, { name: "menu_legacy_id", required: true }, id(), { name: "parent_legacy_id", hint: "One level" }, { name: "sort" }],
  menu_items: [{ name: "section_legacy_id", required: true }, { name: "product_legacy_id", hint: "Or product_sku" }, { name: "product_sku", hint: "Or product_legacy_id" }, { name: "sort" }],
  areas: [{ name: "name", required: true }, { name: "outlet_legacy_id", hint: "Or set the outlet option below" }, id(), { name: "sort" }],
  tables: [{ name: "name", required: true }, { name: "area_legacy_id", required: true }, id(), { name: "seats" }, { name: "shape", hint: "rect, round or square" }, { name: "x" }, { name: "y" }, { name: "w" }, { name: "h" }],
  tender_types: [{ name: "name", required: true }, id(), { name: "is_cash" }, { name: "opens_drawer" }, { name: "is_terminal" }, { name: "sort" }],
  void_reasons: [{ name: "name", required: true }, id(), { name: "for_refunds" }, { name: "sort" }],
  staff: [{ name: "name", required: true }, { name: "role", required: true, hint: "server, cashier, manager, finance or admin" }, id(), { name: "email" }, { name: "pin", hint: "6 digits" }, { name: "outlet_legacy_ids", hint: "Separated by ; or |" }, { name: "active" }],
  customers: [{ name: "name", required: true }, { name: "mobile", hint: "Required unless legacy_id is mapped" }, id("Required unless mobile is mapped"), { name: "email" }, { name: "marketing_consent" }],
  layouts: [
    { name: "label", hint: "Tile label, or map folder" },
    { name: "folder" },
    { name: "brand_legacy_id", required: true },
    { name: "layout_legacy_id" },
    { name: "layout_name" },
    { name: "page" },
    { name: "product_legacy_id", hint: "Or product_sku" },
    { name: "product_sku" },
    { name: "colour", hint: "Name or hex; mapped to the 12 tile colours" },
    { name: "access_level", hint: "everyone, cashier, manager or admin" },
  ],
};

/** Guess an entity from a file name: "products.csv", "menu-items-export.csv". */
export function guessEntity(fileName: string): ImportEntity | null {
  const base = fileName.toLowerCase().replace(/\.csv$/, "").replace(/[-\s]/g, "_");
  for (const e of ENTITY_ORDER) if (base.includes(e)) return e;
  if (base.includes("item")) return "products";
  if (base.includes("modifier")) return "modifier_groups";
  if (base.includes("table")) return "tables";
  return null;
}

/** Parse the first CSV record (the header), honouring quotes. */
export function csvHeader(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else if (ch === "\n" || ch === "\r") break;
    else cur += ch;
  }
  out.push(cur);
  return out.map((h) => h.replace(/^﻿/, "").trim()).filter((h, i, arr) => h !== "" || i < arr.length - 1);
}

/** Count data rows (records after the header), good enough for a summary line. */
export function csvRowCount(text: string): number {
  let rows = 0;
  let quoted = false;
  let sawContent = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') quoted = !quoted;
    else if (ch === "\n" && !quoted) {
      if (sawContent) rows++;
      sawContent = false;
    } else if (ch !== "\r" && ch !== " ") sawContent = true;
  }
  if (sawContent) rows++;
  return Math.max(0, rows - 1);
}

/** Auto-map our field to a header with the same name, ignoring case, spaces and punctuation. */
export function autoMap(fields: ImportField[], headers: string[]): Record<string, string> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const byNorm = new Map(headers.map((h) => [norm(h), h] as const));
  const out: Record<string, string> = {};
  for (const f of fields) {
    const hit = byNorm.get(norm(f.name)) ?? byNorm.get(norm(f.name.replace(/_legacy_id$/, "_id"))) ?? byNorm.get(norm(f.name.replace(/^legacy_id$/, "id")));
    if (hit) out[f.name] = hit;
  }
  return out;
}
