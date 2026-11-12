import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import type { BootstrapResult } from "../src/bootstrap.js";
import { PricingRuleSchema } from "@sail/shared";

/**
 * Demo data for `dev:local`, on top of what each merchant's region preset
 * already created (tax classes, seed rules, tenders). `devSeed` is the
 * Singapore merchant: a hawker-style catalogue with categories, modifiers, a
 * menu, a POS layout, a floor plan, extra tenders (one of them sent to the terminal simulator), void reasons and a VIP
 * group. `devSeedEu` is an EU café priced with inclusive VAT at two rates.
 */
export async function devSeed(url: string, boot: BootstrapResult): Promise<void> {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  const m = boot.merchantId;
  try {
    await sql.begin(async (tx) => {
      const cat = async (name: string, parent: string | null = null) => {
        const id = randomUUID();
        await tx`insert into report_categories (id, merchant_id, parent_id, name) values (${id}, ${m}, ${parent}, ${name})`;
        return id;
      };
      const food = await cat("Food");
      const noodles = await cat("Noodles", food);
      const rice = await cat("Rice", food);
      const sides = await cat("Sides", food);
      const drinks = await cat("Drinks");
      const hot = await cat("Hot drinks", drinks);
      const cold = await cat("Cold drinks", drinks);
      const alcohol = await cat("Alcohol", drinks);

      const prod = async (name: string, price: number, opts: { sku?: string; category?: string | null; tags?: string[]; deposit?: boolean; kind?: "product" | "component"; kitchen?: string; delivery?: number; open?: boolean } = {}) => {
        const id = randomUUID();
        await tx`insert into products (id, merchant_id, name, sku, price, category_id, tags, has_deposit, kind, kitchen_name, open_price)
          values (${id}, ${m}, ${name}, ${opts.sku ?? null}, ${price}, ${opts.category ?? null}, ${opts.tags ?? []}, ${opts.deposit ?? false}, ${opts.kind ?? "product"}, ${opts.kitchen ?? null}, ${opts.open ?? false})`;
        if (opts.delivery) await tx`insert into product_prices (merchant_id, product_id, order_type, price) values (${m}, ${id}, 'delivery', ${opts.delivery})`;
        return id;
      };
      const laksa = await prod("Laksa", 1600, { sku: "LAK-001", category: noodles, tags: ["kitchen", "spicy"], kitchen: "LAKSA", delivery: 1800 });
      const meeGoreng = await prod("Mee Goreng", 1400, { sku: "MEE-001", category: noodles, tags: ["kitchen"] });
      const charKway = await prod("Char Kway Teow", 1500, { sku: "CKT-001", category: noodles, tags: ["kitchen"] });
      const hokkien = await prod("Hokkien Mee", 1500, { sku: "HKM-001", category: noodles, tags: ["kitchen"] });
      const chickenRice = await prod("Chicken Rice", 1200, { sku: "CHR-001", category: rice, tags: ["kitchen"] });
      const nasiLemak = await prod("Nasi Lemak", 1100, { sku: "NSL-001", category: rice, tags: ["kitchen"] });
      const satay = await prod("Satay (10 sticks)", 1800, { sku: "SAT-010", category: sides, tags: ["grill"] });
      const otah = await prod("Otah", 900, { sku: "OTH-001", category: sides, tags: ["grill"] });
      const popiah = await prod("Popiah", 600, { sku: "POP-001", category: sides, tags: ["kitchen"] });
      const kopi = await prod("Kopi", 180, { sku: "KOP-001", category: hot, tags: ["bar"] });
      const teh = await prod("Teh Tarik", 380, { sku: "TEH-001", category: hot, tags: ["bar"] });
      const kopiPeng = await prod("Kopi Peng", 380, { sku: "KOP-PENG", category: cold, tags: ["bar"] });
      const can = await prod("Canned drink", 250, { sku: "CAN-001", category: cold, tags: ["bar"], deposit: true });
      const tiger = await prod("Tiger (bottle)", 1200, { sku: "TGR-001", category: alcohol, tags: ["bar", "alcohol"], deposit: true });
      const wine = await prod("House wine (bottle)", 6600, { sku: "WIN-001", category: alcohol, tags: ["bar", "alcohol"] });
      const openItem = await prod("Open item", 0, { sku: "OPEN", category: sides, open: true });

      // Modifier groups.
      const prawn = await prod("Prawn", 200, { kind: "component", sku: "M-PRAWN" });
      const chicken = await prod("Chicken", 0, { kind: "component", sku: "M-CHICKEN" });
      const veg = await prod("Vegetarian", 0, { kind: "component", sku: "M-VEG" });
      const lessSpicy = await prod("Less spicy", 0, { kind: "component", sku: "M-LESS" });
      const extraSpicy = await prod("Extra spicy", 0, { kind: "component", sku: "M-EXTRA" });
      const noIce = await prod("No ice", 0, { kind: "component", sku: "M-NOICE" });
      const lessSugar = await prod("Less sugar", 0, { kind: "component", sku: "M-LESSSUGAR" });
      const group = async (name: string, min: number, max: number | null, options: [string, number | null][], maxPer = 1) => {
        const id = randomUUID();
        await tx`insert into modifier_groups (id, merchant_id, name, min_select, max_select, max_per_modifier) values (${id}, ${m}, ${name}, ${min}, ${max}, ${maxPer})`;
        for (const [i, [pid, override]] of options.entries()) await tx`insert into modifier_options (merchant_id, group_id, product_id, price_override, sort, is_default) values (${m}, ${id}, ${pid}, ${override}, ${i}, ${i === 0})`;
        return id;
      };
      const protein = await group("Protein", 1, 1, [[prawn, null], [chicken, null], [veg, null]]);
      const spice = await group("Spice", 0, 1, [[lessSpicy, null], [extraSpicy, null]]);
      const drinkMods = await group("Drink options", 0, 2, [[noIce, null], [lessSugar, null]]);
      const attach = async (pid: string, groups: string[]) => {
        for (const [i, g] of groups.entries()) await tx`insert into product_modifier_groups (merchant_id, product_id, group_id, sort) values (${m}, ${pid}, ${g}, ${i})`;
      };
      await attach(laksa, [protein, spice]);
      await attach(meeGoreng, [spice]);
      for (const d of [kopi, teh, kopiPeng]) await attach(d, [drinkMods]);

      // Menu with sections.
      const menuId = randomUUID();
      await tx`insert into menus (id, merchant_id, brand_id, name) values (${menuId}, ${m}, ${boot.brandId}, 'All day')`;
      const section = async (name: string, items: string[], sort: number, parent: string | null = null) => {
        const id = randomUUID();
        await tx`insert into menu_sections (id, merchant_id, menu_id, parent_id, name, sort) values (${id}, ${m}, ${menuId}, ${parent}, ${name}, ${sort})`;
        for (const [i, pid] of items.entries()) await tx`insert into menu_items (merchant_id, menu_id, section_id, product_id, sort) values (${m}, ${menuId}, ${id}, ${pid}, ${i})`;
        return id;
      };
      await section("Noodles", [laksa, meeGoreng, charKway, hokkien], 1);
      await section("Rice", [chickenRice, nasiLemak], 2);
      await section("Sides", [satay, otah, popiah, openItem], 3);
      const drinksSection = await section("Drinks", [], 4);
      await section("Hot", [kopi, teh], 5, drinksSection);
      await section("Cold", [kopiPeng, can, tiger, wine], 6, drinksSection);

      // Channel links: POS and Scan to Order.
      await tx`insert into channel_links (merchant_id, channel, outlet_id, brand_id, menu_id) values (${m}, 'pos', ${boot.outletId}, ${boot.brandId}, ${menuId})`;
      await tx`insert into channel_links (merchant_id, channel, outlet_id, brand_id, menu_id, hold_orders, service_requests) values (${m}, 'scan_to_order', ${boot.outletId}, ${boot.brandId}, ${menuId}, true, ${tx.json(["Water", "Cutlery", "Chilli", "Serviettes"])})`;

      // Floor plan.
      const area = async (name: string, sort: number) => {
        const id = randomUUID();
        await tx`insert into areas (id, merchant_id, outlet_id, name, sort) values (${id}, ${m}, ${boot.outletId}, ${name}, ${sort})`;
        return id;
      };
      const main = await area("Main dining", 1);
      const terrace = await area("Terrace", 2);
      const tables: [string, string, number, string, number, number][] = [
        ["1", main, 2, "square", 0, 0], ["2", main, 2, "square", 3, 0], ["3", main, 4, "round", 6, 0], ["4", main, 6, "rect", 10, 0],
        ["5", main, 2, "square", 0, 3], ["6", main, 2, "square", 3, 3], ["7", main, 4, "round", 6, 3], ["8", main, 4, "round", 10, 3],
        ["11", terrace, 4, "rect", 0, 0], ["12", terrace, 4, "rect", 4, 0], ["13", terrace, 6, "rect", 8, 0],
      ];
      for (const [name, areaId, seats, shape, x, y] of tables) await tx`insert into tables (merchant_id, outlet_id, area_id, name, seats, shape, x, y, w, h) values (${m}, ${boot.outletId}, ${areaId}, ${name}, ${seats}, ${shape}, ${x}, ${y}, ${seats > 4 ? 3 : 2}, 2)`;

      // Tenders beyond the preset's, and void reasons.
      for (const [i, name] of ["House account", "Aggregator"].entries()) await tx`insert into tender_types (merchant_id, name, is_cash, opens_drawer, is_terminal, sort) values (${m}, ${name}, false, false, false, ${10 + i})`;
      // A second card method that sends the payment to the terminal simulator; the preset's Card stays recorded by hand.
      await tx`insert into tender_types (merchant_id, name, is_cash, opens_drawer, is_terminal, provider, terminal_id, sort) values (${m}, 'Card (terminal)', false, false, true, 'simulator', 'sim-1', 5)`;
      await tx`insert into payment_provider_accounts (merchant_id, provider, webhook_secret) values (${m}, 'simulator', ${randomBytes(24).toString("hex")})`;
      for (const [i, name] of ["Customer changed mind", "Wrong item keyed", "Kitchen error", "Guest complaint", "Other"].entries()) await tx`insert into void_reasons (merchant_id, name, sort) values (${m}, ${name}, ${i})`;

      // Customers and a VIP group.
      const vip = randomUUID();
      await tx`insert into customer_groups (id, merchant_id, name, description) values (${vip}, ${m}, 'VIP', 'Regulars with 10% off alcohol above $100')`;
      const cust = randomUUID();
      await tx`insert into customers (id, merchant_id, name, mobile, email, marketing_consent) values (${cust}, ${m}, 'Lim Wei Ling', '+6591234567', 'wei.ling@example.com', true)`;
      await tx`insert into customer_group_members (merchant_id, group_id, customer_id) values (${m}, ${vip}, ${cust})`;

      // Pricing rules: the preset's seed set is already there; add the worked-example rules.
      const extra = [
        { id: "promo:25-off-food", kind: "discount", name: "25% off food", calc: "percent", value: { type: "fixed", amount: 2500 }, scope: { type: "categories", category_ids: [food] }, priority: 10, application: "auto", report_class: "promo", conditions: { order_types: ["dine_in", "takeaway"] } },
        { id: "promo:vip-alcohol", kind: "discount", name: "10% off alcohol above $100 (VIP)", calc: "percent", value: { type: "fixed", amount: 1000 }, scope: { type: "tags", tags: ["alcohol"] }, conditions: { min_spend: { amount: 10_000, basis: "scoped" }, customer_group_ids: [vip] }, priority: 20, application: "auto", report_class: "promo" },
        { id: "fee:delivery", kind: "fee", name: "Delivery fee", calc: "fixed_per_order", value: { type: "fixed", amount: 500 }, scope: { type: "all" }, conditions: { order_types: ["delivery"] }, priority: 120, application: "auto", tax_class_id: boot.taxClassIds.standard, report_class: "delivery_fee" },
      ];
      for (const r of extra) {
        const parsed = PricingRuleSchema.parse(r);
        await tx`insert into pricing_rules (merchant_id, rule_key, version, status, effective_from, body, note, created_by) values (${m}, ${parsed.id}, 1, 'active', '2026-01-01T00:00:00Z', ${tx.json({ ...parsed, version: 1 })}, 'demo', 'system')`;
      }

      // POS layout.
      const tile = (id: string, label: string, product_id: string, color: string, access_level = "everyone") => ({ id, kind: "product", label, product_id, color, access_level });
      const pages = [
        { id: "mains", name: "Mains", tiles: [tile("t1", "Laksa", laksa, "amber"), tile("t2", "Mee Goreng", meeGoreng, "amber"), tile("t3", "Char Kway Teow", charKway, "amber"), tile("t4", "Hokkien Mee", hokkien, "amber"), tile("t5", "Chicken Rice", chickenRice, "brass"), tile("t6", "Nasi Lemak", nasiLemak, "brass")] },
        { id: "sides", name: "Sides", tiles: [tile("s1", "Satay ×10", satay, "brick"), tile("s2", "Otah", otah, "brick"), tile("s3", "Popiah", popiah, "olive"), tile("s4", "Open item", openItem, "stone", "manager")] },
        { id: "drinks", name: "Drinks", tiles: [{ id: "hot", kind: "folder", label: "Hot", color: "teal", access_level: "everyone", tiles: [tile("d1", "Kopi", kopi, "teal"), tile("d2", "Teh Tarik", teh, "teal")] }, tile("d3", "Kopi Peng", kopiPeng, "sky"), tile("d4", "Canned drink", can, "sky"), tile("d5", "Tiger", tiger, "indigo", "cashier"), tile("d6", "House wine", wine, "plum", "cashier")] },
      ];
      const layoutId = randomUUID();
      await tx`insert into pos_layouts (id, merchant_id, brand_id, name, pages) values (${layoutId}, ${m}, ${boot.brandId}, 'Sample Kitchen main', ${tx.json(pages)})`;
      await tx`update stations set layout_id = ${layoutId} where id = ${boot.stationId}`;

      // More staff for PIN sign-in.
      const { hashSecret, pinLookup } = await import("../src/auth/tokens.js");
      for (const [name, role, pin] of [["Mia Manager", "manager", "222222"], ["Cal Cashier", "cashier", "333333"], ["Sam Server", "server", "444444"], ["Fin Finance", "finance", "555555"]] as const) {
        await tx`insert into staff (merchant_id, name, initials, email, role, pin_hash, pin_lookup) values (${m}, ${name}, ${name.split(" ").map((w) => w[0]).join("")}, ${name.toLowerCase().replace(" ", ".") + "@sail.local"}, ${role}, ${hashSecret(pin)}, ${pinLookup(m, pin)})`;
      }
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * The EU demo merchant (preset `eu-vat`, EUR, de-DE, Europe/Berlin): food at
 * the reduced 10% rate, drinks at the standard 20%, prices tax-inclusive and
 * rounded once per rate, so a mixed bill prints two VAT lines.
 */
export async function devSeedEu(url: string, boot: BootstrapResult): Promise<void> {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  const m = boot.merchantId;
  const reduced = boot.taxClassIds.reduced!;
  try {
    await sql.begin(async (tx) => {
      const cat = async (name: string) => {
        const id = randomUUID();
        await tx`insert into report_categories (id, merchant_id, name) values (${id}, ${m}, ${name})`;
        return id;
      };
      const food = await cat("Speisen");
      const drinks = await cat("Getränke");
      // Products with no tax class use the default class (standard, VAT 20%).
      const prod = async (name: string, price: number, category: string, tags: string[], taxClassId: string | null = null) => {
        const id = randomUUID();
        await tx`insert into products (id, merchant_id, name, price, category_id, tags, tax_class_id) values (${id}, ${m}, ${name}, ${price}, ${category}, ${tags}, ${taxClassId})`;
        return id;
      };
      const items = [
        await prod("Schnitzel mit Kartoffelsalat", 1690, food, ["kitchen"], reduced),
        await prod("Käsespätzle", 1350, food, ["kitchen"], reduced),
        await prod("Brezel", 350, food, ["kitchen"], reduced),
        await prod("Apfelstrudel", 650, food, ["kitchen"], reduced),
        await prod("Pils 0,5 l", 490, drinks, ["bar"]),
        await prod("Riesling 0,2 l", 720, drinks, ["bar"]),
        await prod("Apfelschorle", 390, drinks, ["bar"]),
        await prod("Kaffee", 320, drinks, ["bar"]),
      ];
      const menuId = randomUUID();
      await tx`insert into menus (id, merchant_id, brand_id, name) values (${menuId}, ${m}, ${boot.brandId}, 'Tageskarte')`;
      const sectionId = randomUUID();
      await tx`insert into menu_sections (id, merchant_id, menu_id, name, sort) values (${sectionId}, ${m}, ${menuId}, 'Alles', 1)`;
      for (const [i, pid] of items.entries()) await tx`insert into menu_items (merchant_id, menu_id, section_id, product_id, sort) values (${m}, ${menuId}, ${sectionId}, ${pid}, ${i})`;
      await tx`insert into channel_links (merchant_id, channel, outlet_id, brand_id, menu_id) values (${m}, 'pos', ${boot.outletId}, ${boot.brandId}, ${menuId})`;
      const area = randomUUID();
      await tx`insert into areas (id, merchant_id, outlet_id, name, sort) values (${area}, ${m}, ${boot.outletId}, 'Gastraum', 1)`;
      for (const [i, name] of ["1", "2", "3", "4"].entries()) await tx`insert into tables (merchant_id, outlet_id, area_id, name, seats, shape, x, y, w, h) values (${m}, ${boot.outletId}, ${area}, ${name}, 4, 'square', ${i * 3}, 0, 2, 2)`;
      for (const [i, name] of ["Falsch gebucht", "Gast hat storniert", "Küchenfehler"].entries()) await tx`insert into void_reasons (merchant_id, name, sort) values (${m}, ${name}, ${i})`;
      await tx`update outlets set address = 'Musterstraße 1, 10115 Berlin', business_registration_no = 'HRB 123456 B', tax_registration_no = 'DE123456789' where id = ${boot.outletId}`;
      const rule = PricingRuleSchema.parse({ id: "promo:happy-hour", kind: "discount", name: "Happy Hour 20% auf Getränke", calc: "percent", value: { type: "fixed", amount: 2000 }, scope: { type: "categories", category_ids: [drinks] }, priority: 10, application: "auto", report_class: "promo" });
      await tx`insert into pricing_rules (merchant_id, rule_key, version, status, effective_from, body, note, created_by) values (${m}, ${rule.id}, 1, 'active', '2026-01-01T00:00:00Z', ${tx.json({ ...rule, version: 1 })}, 'demo', 'system')`;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
