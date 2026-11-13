import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { presetSeedRules, REGION_PRESETS, resolveTaxRate, type OrderType, type PricingRuleInput, type RegionPresetKey, type TaxRate } from "@sail/shared";
import "../src/modules.js";
import { buildApp } from "../src/app.js";
import { withTransaction } from "../src/db/client.js";
import { seedRulesForMerchant } from "../src/services/pricing-rules.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";
import { taxDisagreements, type TaxedItem } from "./tax-oracle.js";

/**
 * Money fuzzer: a seeded random walk over the HTTP API in five regimes (SGD exclusive per line; EUR inclusive per rate
 * with 0.05 cash rounding; USD with a two-part rate; JPY with order-type rates and 10-yen rounding; KWD with three
 * decimals in ar-KW). After every step it checks the money invariants from the database, the tax against an independent
 * oracle (tax-oracle.ts) and every bill's printed rows; every few steps the Z-report, its reconciliation and the sales
 * summary; at the end the shift closes at no variance when the count is the cash the rows say is there.
 *
 * Deterministic: the walk depends only on the seed. FUZZ_STEPS (per regime) and FUZZ_SEEDS (comma list) run it longer.
 */
const STEPS = Number(process.env.FUZZ_STEPS ?? 300);
const SEEDS = (process.env.FUZZ_SEEDS ?? "1").split(",").map(Number);

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  return {
    f: next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    chance: (p: number) => next() < p,
  };
}
type R = ReturnType<typeof rng>;

type Regime = { key: string; preset: RegionPresetKey; currency?: string; locale?: string; timeZone: string; cashRounding?: number; products: { code: string; price: number; cls: string; tags?: string[] }[]; feeClass: string; /** The largest open price the walk enters. */ openMax?: number };
const REGIMES: Regime[] = [
  { key: "sg", preset: "sg", timeZone: "Asia/Singapore", feeClass: "standard", products: [{ code: "laksa", price: 1650, cls: "standard" }, { code: "kopi", price: 185, cls: "standard" }, { code: "wine", price: 12005, cls: "standard" }, { code: "sweet", price: 5, cls: "standard", tags: ["promo"] }, { code: "cake", price: 333, cls: "standard", tags: ["promo"] }] },
  { key: "eu", preset: "eu-vat", timeZone: "Europe/Dublin", cashRounding: 5, feeClass: "standard", products: [{ code: "wine", price: 900, cls: "standard" }, { code: "water", price: 350, cls: "standard" }, { code: "pasta", price: 1450, cls: "reduced" }, { code: "bread", price: 3, cls: "reduced", tags: ["promo"] }, { code: "book", price: 1299, cls: "exempt" }, { code: "shot", price: 5, cls: "standard" }] },
  { key: "us", preset: "us", timeZone: "America/New_York", feeClass: "prepared_food", products: [{ code: "burger", price: 1299, cls: "prepared_food" }, { code: "fries", price: 349, cls: "prepared_food" }, { code: "soda", price: 249, cls: "prepared_food", tags: ["promo"] }, { code: "apples", price: 199, cls: "exempt" }, { code: "gum", price: 3, cls: "prepared_food" }] },
  { key: "jp", preset: "jp", timeZone: "Asia/Tokyo", cashRounding: 10, feeClass: "food", products: [{ code: "ramen", price: 980, cls: "food" }, { code: "beer", price: 580, cls: "alcohol" }, { code: "gyoza", price: 1, cls: "food", tags: ["promo"] }, { code: "onigiri", price: 155, cls: "food" }, { code: "sake", price: 12345, cls: "alcohol" }] },
  // Amounts past 2^31 minor units on every line, bill, payment and report: the walk would hit any 32-bit path left.
  { key: "id", preset: "sg", currency: "IDR", locale: "id-ID", timeZone: "Asia/Jakarta", feeClass: "standard", openMax: 3_000_000_000, products: [{ code: "banquet", price: 1_234_567_891, cls: "standard" }, { code: "teh", price: 1_500_000, cls: "standard" }, { code: "kerupuk", price: 7, cls: "standard", tags: ["promo"] }, { code: "rendang", price: 2_147_483_647, cls: "standard", tags: ["promo"] }] },
  { key: "kw", preset: "us", currency: "KWD", locale: "ar-KW", timeZone: "Asia/Kuwait", cashRounding: 5, feeClass: "prepared_food", products: [{ code: "burger", price: 2125, cls: "prepared_food" }, { code: "fries", price: 755, cls: "prepared_food", tags: ["promo"] }, { code: "soda", price: 333, cls: "prepared_food" }, { code: "dates", price: 1999, cls: "exempt" }, { code: "mint", price: 7, cls: "prepared_food" }] },
];

type Call = ReturnType<typeof api>["call"];
type Res = { status: number; body: unknown };
type Ctx = { r: Regime; db: TestDb; call: Call; m: SeededMerchant; pin: string; admin: string; products: Record<string, string>; tables: string[]; cash: string; card: string; increment: number; shiftId: string; float: number };

async function buildWorld(r: Regime, db: TestDb): Promise<Ctx> {
  const call = api(buildApp()).call;
  const m = await seedMerchant(db.sql, `Fuzz ${r.key} ${randomUUID().slice(0, 4)}`, { preset: r.preset, timeZone: r.timeZone, currency: r.currency, locale: r.locale, cashRoundingIncrement: r.cashRounding });
  const tc = m.taxClassIds;
  const fee = tc[r.feeClass]!;
  const extra: PricingRuleInput[] = [
    ...(REGION_PRESETS[r.preset].service_charge ? [] : [{ id: "fz:svc", kind: "fee", name: "Service 10%", calc: "percent", value: { type: "fixed", amount: 1000 }, scope: { type: "all" }, conditions: { order_types: ["dine_in"] }, priority: 900, application: "auto", tax_class_id: fee, report_class: "service_charge" } satisfies PricingRuleInput]),
    { id: "fz:bag", kind: "fee", name: "Bag fee", calc: "fixed_per_order", value: { type: "fixed", amount: 7 }, scope: { type: "all" }, conditions: { order_types: ["takeaway"] }, priority: 950, application: "auto", tax_class_id: fee, report_class: "packaging_fee" },
    { id: "fz:promo", kind: "discount", name: "Promo 15%", calc: "percent", level: "line", value: { type: "fixed", amount: 1500 }, cap: 37, scope: { type: "tags", tags: ["promo"] }, priority: 50, application: "auto", report_class: "promo" },
    { id: "fz:spend", kind: "discount", name: "Spend 50 save 3", calc: "fixed_per_order", level: "order", value: { type: "fixed", amount: 301 }, scope: { type: "all" }, conditions: { min_spend: { amount: 5000, basis: "order" } }, priority: 60, application: "auto", report_class: "promo" },
  ];
  await withTransaction(() => seedRulesForMerchant(m.merchantId, [...presetSeedRules(REGION_PRESETS[r.preset], tc), ...extra]));
  const t = m.admin.token;
  const must = async <T,>(method: string, path: string, body: unknown, token: string | undefined = t): Promise<T> => {
    const res = await call<T>(method, path, { token, body });
    if (res.status >= 300) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const products: Record<string, string> = {};
  for (const p of r.products) {
    products[p.code] = randomUUID();
    await must("POST", "/v1/products", { id: products[p.code], name: p.code, price: p.price, tags: ["kitchen", ...(p.tags ?? [])], tax_class_id: tc[p.cls] });
  }
  products.open = randomUUID();
  await must("POST", "/v1/products", { id: products.open, name: "Open item", price: 0, open_price: true, tax_class_id: fee });
  const ids = Object.fromEntries(["menu", "posLink", "station", "cash", "card", "kitchen", "receipt", "area"].map((k) => [k, randomUUID()])) as Record<"menu" | "posLink" | "station" | "cash" | "card" | "kitchen" | "receipt" | "area", string>;
  await must("POST", "/v1/menus", { id: ids.menu, brand_id: m.brandId, name: "M", sections: [{ name: "All", items: Object.values(products).map((id) => ({ product_id: id })) }] });
  await must("POST", "/v1/channel-links", { id: ids.posLink, channel: "pos", outlet_id: m.outletId, brand_id: m.brandId, menu_id: ids.menu });
  await must("POST", "/v1/printers", { id: ids.kitchen, outlet_id: m.outletId, name: "Kitchen", ip: "10.0.0.1", is_default_kitchen: true });
  await must("POST", "/v1/printers", { id: ids.receipt, outlet_id: m.outletId, name: "Receipt", ip: "10.0.0.9", role: "receipt" });
  await must("POST", "/v1/tender-types", { id: ids.cash, name: "Cash", is_cash: true });
  await must("POST", "/v1/tender-types", { id: ids.card, name: "Card", is_terminal: true });
  await must("POST", "/v1/stations", { id: ids.station, outlet_id: m.outletId, brand_id: m.brandId, name: "Floor", receipt_printer_id: ids.receipt });
  await must("POST", "/v1/areas", { id: ids.area, outlet_id: m.outletId, name: "Main" });
  const tables: string[] = [];
  for (let i = 0; i < 6; i++) {
    const id = randomUUID();
    await must("POST", "/v1/tables", { id, outlet_id: m.outletId, area_id: ids.area, name: `T${i}` });
    tables.push(id);
  }
  const code = await must<{ data: { code: string } }>("POST", `/v1/stations/${ids.station}/pairing-code`, {});
  const pair = await call<{ data: { station_token: string } }>("POST", "/v1/stations/pair", { body: { code: code.data.code, device_label: "iPad" }, idempotencyKey: null });
  const session = await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: pair.body.data.station_token, body: { pin: "222222" } });
  const [settings] = await db.sql<{ cash_rounding_increment: number | null }[]>`select cash_rounding_increment from merchant_settings where merchant_id = ${m.merchantId}`;
  const float = 10_007;
  const shift = await must<{ data: { id: string } }>("POST", "/v1/shifts", { outlet_id: m.outletId, station_id: null, float_cents: float });
  return { r, db, call, m, pin: session.body.data.session_token, admin: t, products, tables, cash: ids.cash, card: ids.card, increment: settings?.cash_rounding_increment ?? 1, shiftId: shift.data.id, float };
}

/* ---------------- invariants, from the database ---------------- */

type Tax = { name: string; bps: number; amount: number };
type OrderRow = { id: string; status: string; outlet_id: string; order_type: OrderType; tax_mode: string; tax_rounding: string; tax_rates: TaxRate[]; subtotal: number; discount_total: number; fee_total: number; tax_total: number; total: number; taxes: Tax[] };
type LineRow = { id: string; order_id: string; quantity: number; tax_class_id: string; net_amount: number; fee_amount: number; tax_amount: number; total: number; taxes: Tax[] };
type AdjRow = { id: string; kind: string };
type AdjLineRow = { order_line_id: string; amount: number; tax_amount: number; kind: string; tax_class_id: string | null; order_id: string };
type CheckRow = { id: string; order_id: string; total: number; paid_total: number; rounding_total: number; refunded_total: number; discount_total: number; fee_total: number; tax_total: number; taxes: Tax[]; locked: boolean };
type AllocRow = { check_id: string; order_line_id: string; share_num: number; share_den: number; total: number; tax: number; adjustments: Record<string, { amount: number; tax: number }> };
type PayRow = { id: string; check_id: string; amount: number; rounding_cents: number; status: string };
type RefundRow = { id: string; check_id: string; total: number };
type RefundLineRow = { refund_id: string; order_line_id: string; quantity: number; total: number; taxes: Tax[] };
type RefundTenderRow = { payment_id: string; amount: number; rounding_cents: number; is_cash: boolean };

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const byComponent = (ts: Tax[] | null) => {
  const m = new Map<string, number>();
  for (const t of ts ?? []) m.set(`${t.name}|${t.bps}`, (m.get(`${t.name}|${t.bps}`) ?? 0) + t.amount);
  for (const [k, x] of m) if (x === 0) m.delete(k);
  return m;
};
const same = (a: Map<string, number>, b: Map<string, number>) => a.size === b.size && [...a].every(([k, x]) => b.get(k) === x);

async function invariants(c: Ctx): Promise<string[]> {
  const v: string[] = [];
  const sql = c.db.sql;
  const mid = c.m.merchantId;
  const [orders, lines, adjs, adjLines, checks, allocs, pays, refunds, refundLines, refundTenders] = await Promise.all([
    sql<OrderRow[]>`select id, status, outlet_id, order_type, tax_mode, tax_rounding, tax_rates, subtotal, discount_total, fee_total, tax_total, total, taxes from orders where merchant_id = ${mid}`,
    sql<LineRow[]>`select id, order_id, quantity, tax_class_id, net_amount, fee_amount, tax_amount, total, taxes from order_lines where merchant_id = ${mid} and status <> 'voided'`,
    sql<AdjRow[]>`select id, kind from order_adjustments where merchant_id = ${mid}`,
    sql<AdjLineRow[]>`select al.order_line_id, al.amount, al.tax_amount, a.kind, a.tax_class_id, a.order_id from order_adjustment_lines al join order_adjustments a on a.id = al.adjustment_id where a.merchant_id = ${mid}`,
    sql<CheckRow[]>`select id, order_id, total, paid_total, rounding_total, refunded_total, discount_total, fee_total, tax_total, taxes, locked_at is not null as locked from checks where merchant_id = ${mid}`,
    sql<AllocRow[]>`select ca.check_id, ca.order_line_id, ca.share_num, ca.share_den, ca.total, ca.tax, ca.adjustments from check_allocations ca join checks c on c.id = ca.check_id where c.merchant_id = ${mid}`,
    sql<PayRow[]>`select id, check_id, amount, rounding_cents, status from payments where merchant_id = ${mid}`,
    sql<RefundRow[]>`select id, check_id, total from refunds where merchant_id = ${mid}`,
    sql<RefundLineRow[]>`select refund_id, order_line_id, quantity, total, taxes from refund_lines where merchant_id = ${mid}`,
    sql<RefundTenderRow[]>`select payment_id, amount, rounding_cents, is_cash from refund_tenders where merchant_id = ${mid}`,
  ]);
  const adjKind = new Map(adjs.map((a) => [a.id, a.kind]));

  for (const o of orders) {
    const ls = lines.filter((l) => l.order_id === o.id);
    if (sum(ls.map((l) => l.total)) !== o.total) v.push(`order ${o.id}: lines add up to ${sum(ls.map((l) => l.total))}, not ${o.total}`);
    const parts = o.subtotal + o.discount_total + o.fee_total + (o.tax_mode === "exclusive" ? o.tax_total : 0);
    if (parts !== o.total) v.push(`order ${o.id}: parts add up to ${parts}, not ${o.total}`);
    if (!same(byComponent(ls.flatMap((l) => l.taxes)), byComponent(o.taxes))) v.push(`order ${o.id}: lines' tax by component differs from the order's`);
    for (const l of ls) {
      if (sum(l.taxes.map((t) => t.amount)) !== l.tax_amount) v.push(`line ${l.id}: components do not add up to its tax`);
      if ((o.tax_mode === "exclusive" ? l.net_amount + l.fee_amount + l.tax_amount : l.net_amount + l.fee_amount) !== l.total) v.push(`line ${l.id}: parts do not add up to its total`);
      if (l.net_amount < 0 || l.total < 0 || l.taxes.some((t) => t.amount < 0)) v.push(`line ${l.id}: below zero (net ${l.net_amount}, total ${l.total})`);
    }
    const cs = checks.filter((x) => x.order_id === o.id);
    if (cs.length && o.status !== "cancelled") {
      if (sum(cs.map((x) => x.total)) !== o.total) v.push(`order ${o.id}: bills add up to ${sum(cs.map((x) => x.total))}, not ${o.total}`);
      if (!same(byComponent(cs.flatMap((x) => x.taxes)), byComponent(o.taxes))) v.push(`order ${o.id}: bills' tax by component differs from the order's`);
    }
    for (const ch of cs) {
      const ps = pays.filter((p) => p.check_id === ch.id && p.status === "recorded");
      if (sum(ps.map((p) => p.amount)) !== ch.paid_total) v.push(`bill ${ch.id}: paid ${ch.paid_total} but payments are ${sum(ps.map((p) => p.amount))}`);
      if (sum(ps.map((p) => p.rounding_cents)) !== ch.rounding_total) v.push(`bill ${ch.id}: rounding differs from its payments`);
      const rf = refunds.filter((x) => x.check_id === ch.id);
      if (sum(rf.map((x) => x.total)) !== ch.refunded_total) v.push(`bill ${ch.id}: refunded total differs from its refunds`);
      if (ch.refunded_total > ch.paid_total || ch.paid_total > ch.total) v.push(`bill ${ch.id}: refunded ${ch.refunded_total} / paid ${ch.paid_total} / total ${ch.total}`);
      if (ch.total < 0 || ch.taxes.some((t) => t.amount < 0)) v.push(`bill ${ch.id}: below zero`);
      if (sum(ch.taxes.map((t) => t.amount)) !== ch.tax_total) v.push(`bill ${ch.id}: tax components do not add up`);
      const billTax = byComponent(ch.taxes);
      const myRefundLines = refundLines.filter((x) => rf.some((r) => r.id === x.refund_id));
      for (const [k, x] of byComponent(myRefundLines.flatMap((x) => x.taxes))) if (Math.abs(x) > Math.abs(billTax.get(k) ?? 0)) v.push(`bill ${ch.id}: refunded ${k} ${x} is more than the bill's`);
      const al = allocs.filter((a) => a.check_id === ch.id);
      for (const a of al) {
        const back = myRefundLines.filter((x) => x.order_line_id === a.order_line_id);
        const line = ls.find((l) => l.id === a.order_line_id);
        if (line && a.share_num === a.share_den && sum(back.map((x) => x.quantity)) >= line.quantity && sum(back.map((x) => x.total)) !== a.total) v.push(`bill ${ch.id}: every unit of line ${a.order_line_id} refunded but ${sum(back.map((x) => x.total))} of ${a.total} given back`);
      }
      // What the receipt prints: every row names a live adjustment, and the rows add up to the bill's discount and fee.
      const keys = al.flatMap((a) => Object.keys(a.adjustments));
      if (keys.some((k) => !adjKind.has(k))) v.push(`bill ${ch.id}: a printed row names an adjustment that no longer exists`);
      let d = 0;
      let f = 0;
      for (const a of al) for (const [k, x] of Object.entries(a.adjustments)) adjKind.get(k) === "discount" ? (d += x.amount) : (f += x.amount);
      if (keys.every((k) => adjKind.has(k)) && (d !== ch.discount_total || f !== ch.fee_total)) v.push(`bill ${ch.id}: rows ${d}/${f} differ from its discount ${ch.discount_total} and fee ${ch.fee_total}`);
    }
    if (o.status === "completed" && cs.some((x) => x.total > x.paid_total)) v.push(`order ${o.id}: completed but not paid`);

    // The independent oracle. Per rate, only on orders with no paid line (a paid bill keeps its own rounding, §2 step 5).
    const lockedLines = new Set(allocs.filter((a) => cs.some((x) => x.id === a.check_id && x.locked)).map((a) => a.order_line_id));
    if (o.tax_rounding === "per_line" || !ls.some((l) => lockedLines.has(l.id))) {
      const rate = (cls: string) => resolveTaxRate(o.tax_rates, cls, o.outlet_id, o.order_type).components;
      const fees = adjLines.filter((a) => a.order_id === o.id && a.kind === "fee" && a.tax_class_id);
      const items: TaxedItem[] = [
        ...ls.map((l) => ({ components: rate(l.tax_class_id), amount: l.net_amount, tax: l.tax_amount - sum(adjLines.filter((a) => a.order_line_id === l.id && a.kind === "fee").map((a) => a.tax_amount)) })),
        ...fees.map((a) => ({ components: rate(a.tax_class_id!), amount: a.amount, tax: a.tax_amount })),
      ];
      for (const msg of taxDisagreements(items, o.tax_mode, o.tax_rounding)) v.push(`order ${o.id}: ${msg}`);
    }
  }
  for (const p of pays) {
    const back = refundTenders.filter((t) => t.payment_id === p.id);
    if (sum(back.map((t) => t.amount)) > p.amount) v.push(`payment ${p.id}: refunded more than it took`);
    if (back.some((t) => t.is_cash) && sum(back.map((t) => t.amount + t.rounding_cents)) > p.amount + p.rounding_cents) v.push(`payment ${p.id}: paid out more cash than it took`);
    if (back.length && p.status !== "recorded") v.push(`payment ${p.id}: refunded and then ${p.status}`);
  }
  return v;
}

type Z = { scope: { business_date: string }; sales: { gross: number; discounts: number; fees: number; tax: number; taxes: Tax[]; refunds: number; net: number; total: number }; tenders: { amount: number }[]; refunds: { amount: number }; cash: { expected: number }; reconciliation: { tenders: number; sales_total: number; paid_on_other_orders: number; paid_elsewhere: number } };
type Summary = { totals: { total: number; net: number; tax: number }; by_tender: { amount: number }[]; by_day: { net: number }[]; by_category: { net: number }[]; by_order_type: { net: number }[] };

async function reports(c: Ctx): Promise<string[]> {
  const v: string[] = [];
  const sql = c.db.sql;
  const z = await c.call<{ data: Z }>("GET", `/v1/outlets/${c.m.outletId}/z-report`, { token: c.admin });
  if (z.status !== 200) return [`z-report ${z.status}`];
  const Z = z.body.data;
  const bd = Z.scope.business_date;
  const [pays, refundTotal, cashBack, done, shift] = await Promise.all([
    sql<{ amount: number; rounding_cents: number; tip_cents: number; is_cash: boolean }[]>`select amount, rounding_cents, tip_cents, is_cash from payments where outlet_id = ${c.m.outletId} and status = 'recorded' and business_date = ${bd}`,
    sql<{ n: number }[]>`select coalesce(sum(total),0)::bigint as n from refunds where outlet_id = ${c.m.outletId} and business_date = ${bd}`,
    sql<{ n: number }[]>`select coalesce(sum(t.amount + t.rounding_cents),0)::bigint as n from refund_tenders t join refunds r on r.id = t.refund_id where r.outlet_id = ${c.m.outletId} and r.business_date = ${bd} and t.is_cash`,
    sql<{ n: number }[]>`select coalesce(sum(total),0)::bigint as n from orders where outlet_id = ${c.m.outletId} and business_date = ${bd} and status = 'completed'`,
    sql<{ bd: string }[]>`select business_date::text as bd from shifts where id = ${c.shiftId}`,
  ]);
  const tenders = sum(Z.tenders.map((t) => t.amount));
  if (tenders !== sum(pays.map((p) => p.amount))) v.push(`Z tenders ${tenders} differ from the payments`);
  const cash = (shift[0]?.bd === bd ? c.float : 0) + sum(pays.filter((p) => p.is_cash).map((p) => p.amount + p.rounding_cents + p.tip_cents)) - cashBack[0]!.n;
  if (Z.cash.expected !== cash) v.push(`Z expected cash ${Z.cash.expected}, rows say ${cash}`);
  if (Z.refunds.amount !== refundTotal[0]!.n) v.push("Z refunds differ from the refunds");
  if (Z.sales.total !== done[0]!.n) v.push(`Z sales ${Z.sales.total}, completed orders ${done[0]!.n}`);
  if (Z.sales.net + Z.sales.refunds + Z.sales.fees + Z.sales.tax !== Z.sales.total) v.push("Z: net + refunds + fees + tax is not the total");
  if (sum(Z.sales.taxes.map((t) => t.amount)) !== Z.sales.tax) v.push("Z: tax components do not add up");
  const rc = Z.reconciliation;
  if (rc.tenders !== tenders || rc.sales_total !== Z.sales.total || rc.tenders !== rc.sales_total + rc.paid_on_other_orders - rc.paid_elsewhere) v.push(`Z reconciliation does not hold: ${JSON.stringify(rc)}`);
  const s = await c.call<{ data: Summary }>("GET", `/v1/reports/sales-summary?outlet_id=${c.m.outletId}&from=${bd}&to=${bd}`, { token: c.admin });
  if (s.status !== 200) return [...v, `sales summary ${s.status}`];
  const S = s.body.data;
  if (S.totals.total !== Z.sales.total || S.totals.net !== Z.sales.net || S.totals.tax !== Z.sales.tax) v.push("sales summary differs from the Z-report");
  if (sum(S.by_tender.map((t) => t.amount)) !== tenders) v.push("sales summary tenders differ from the Z-report's");
  for (const [name, rows] of [["day", S.by_day], ["category", S.by_category], ["order type", S.by_order_type]] as const) if (sum(rows.map((x) => x.net)) !== S.totals.net) v.push(`sales summary net by ${name} does not add up`);
  return v;
}

/* ---------------- actions ---------------- */

const LIVE = ["open", "fired", "ready"];
async function liveOrder(c: Ctx, g: R): Promise<string | null> {
  const rows = await c.db.sql<{ id: string }[]>`select id from orders where merchant_id = ${c.m.merchantId} and status in ${c.db.sql(LIVE)} order by opened_at, id`;
  if (!rows.length) return null;
  return (g.chance(0.6) ? rows[rows.length - 1]! : g.pick(rows)).id;
}
const pickRow = <T,>(g: R, rows: T[]): T | null => (rows.length ? g.pick(rows) : null);
type Snap = { lines: { id: string; status: string; quantity: number }[]; checks: { id: string }[] };
const snapshot = async (c: Ctx, id: string) => (await c.call<{ data: Snap }>("GET", `/v1/orders/${id}`, { token: c.pin })).body.data;

const actions: { name: string; w: number; run: (c: Ctx, g: R) => Promise<Res | null> }[] = [
  { name: "open", w: 6, run: async (c, g) => {
    const type = g.pick(["takeaway", "dine_in"] as const);
    const busy = new Set((await c.db.sql<{ table_id: string }[]>`select table_id from orders where merchant_id = ${c.m.merchantId} and status in ${c.db.sql(LIVE)} and table_id is not null`).map((x) => x.table_id));
    const free = c.tables.filter((t) => !busy.has(t));
    const body: Record<string, unknown> = { order_id: randomUUID(), order_type: type, outlet_id: c.m.outletId, brand_id: c.m.brandId };
    if (type === "dine_in") {
      if (!free.length) return null;
      Object.assign(body, { table_id: g.pick(free), pax: g.int(1, 6) });
    } else body.takeaway_ref = "T";
    return c.call("POST", "/v1/orders", { token: c.pin, body });
  } },
  { name: "add", w: 10, run: async (c, g) => {
    const o = await liveOrder(c, g);
    if (!o) return null;
    const lines = Array.from({ length: g.int(1, 3) }, () =>
      g.chance(0.12)
        ? { line_id: randomUUID(), product_id: c.products.open, quantity: g.int(1, 3), open_price: g.int(1, c.r.openMax ?? 99_999), seat_no: g.chance(0.5) ? g.int(1, 3) : null }
        : { line_id: randomUUID(), product_id: c.products[g.pick(c.r.products).code], quantity: g.int(1, 5), seat_no: g.chance(0.5) ? g.int(1, 3) : null },
    );
    return c.call("POST", `/v1/orders/${o}/lines`, { token: c.pin, body: { lines } });
  } },
  { name: "qty", w: 3, run: async (c, g) => {
    const l = pickRow(g, await c.db.sql<{ id: string; order_id: string }[]>`select l.id, l.order_id from order_lines l join orders o on o.id = l.order_id where o.merchant_id = ${c.m.merchantId} and l.status in ('pending','held') and o.status in ${c.db.sql(LIVE)} order by l.id`);
    return l ? c.call("PATCH", `/v1/orders/${l.order_id}/lines/${l.id}`, { token: c.pin, body: { quantity: g.int(1, 7) } }) : null;
  } },
  { name: "void-line", w: 3, run: async (c, g) => {
    const l = pickRow(g, await c.db.sql<{ id: string; order_id: string; quantity: number }[]>`select l.id, l.order_id, l.quantity from order_lines l join orders o on o.id = l.order_id where o.merchant_id = ${c.m.merchantId} and l.status <> 'voided' and o.status in ${c.db.sql(LIVE)} order by l.id`);
    return l ? c.call("POST", `/v1/orders/${l.order_id}/lines/${l.id}/void`, { token: c.pin, body: { reason_text: "fz", quantity: g.chance(0.5) ? g.int(1, l.quantity) : undefined } }) : null;
  } },
  { name: "fire", w: 5, run: async (c, g) => {
    const o = await liveOrder(c, g);
    return o ? c.call("POST", `/v1/orders/${o}/fire`, { token: c.pin, body: {} }) : null;
  } },
  { name: "discount", w: 5, run: async (c, g) => {
    const o = await liveOrder(c, g);
    if (!o) return null;
    const live = (await snapshot(c, o)).lines.filter((l) => l.status !== "voided");
    const kind = g.pick(["seed:percent-off-item", "seed:percent-off-bill", "seed:amount-off-bill", "seed:staff-meal", "seed:manager-comp", "seed:service-charge-waiver"]);
    const body: Record<string, unknown> = { application_id: randomUUID(), rule_key: kind, reason: "fz" };
    if (kind === "seed:percent-off-item") {
      body.entered_value = g.int(1, 5000);
      if (live.length && g.chance(0.6)) body.line_ids = [g.pick(live).id];
    }
    if (kind === "seed:percent-off-bill") body.entered_value = g.pick([1, 333, 1000, 1500, 2500, 5000, 9999, 10000]);
    if (kind === "seed:amount-off-bill") body.entered_value = g.int(1, 3000);
    if ((kind === "seed:staff-meal" || kind === "seed:manager-comp") && live.length && g.chance(0.7)) body.line_ids = [g.pick(live).id];
    return c.call("POST", `/v1/orders/${o}/adjustments`, { token: c.pin, body });
  } },
  { name: "undiscount", w: 2, run: async (c, g) => {
    const a = pickRow(g, await c.db.sql<{ id: string; order_id: string }[]>`select a.id, a.order_id from order_manual_applications a join orders o on o.id = a.order_id where o.merchant_id = ${c.m.merchantId} and a.removed_at is null and o.status in ${c.db.sql(LIVE)} order by a.id`);
    return a ? c.call("DELETE", `/v1/orders/${a.order_id}/adjustments/${a.id}`, { token: c.pin, body: { reason: "fz" } }) : null;
  } },
  { name: "split", w: 3, run: async (c, g) => {
    const o = await liveOrder(c, g);
    if (!o) return null;
    const mode = g.int(0, 3);
    if (mode === 0) return c.call("POST", `/v1/orders/${o}/checks/split-even`, { token: c.pin, body: { n: g.int(2, 4) } });
    if (mode === 1) return c.call("POST", `/v1/orders/${o}/checks/split-by-seat`, { token: c.pin, body: { shared: g.pick(["even", "manual"]) } });
    if (mode === 2) return c.call("POST", `/v1/orders/${o}/checks/unsplit`, { token: c.pin, body: {} });
    const s = await snapshot(c, o);
    const live = s.lines.filter((l) => l.status !== "voided");
    const bills = s.checks.map((x) => x.id);
    if (!live.length || !bills.length) return null;
    const targets = g.chance(0.4) && bills.length > 1 ? [bills[0], bills[bills.length - 1]] : [g.pick(bills)];
    return c.call("POST", `/v1/orders/${o}/checks/allocate`, { token: c.pin, body: { moves: [{ line_id: g.pick(live).id, check_ids: targets }], add_checks: g.int(0, 1) } });
  } },
  { name: "pay", w: 12, run: async (c, g) => {
    const ch = pickRow(g, await c.db.sql<{ id: string; balance: number }[]>`select c.id, c.total - c.paid_total as balance from checks c join orders o on o.id = c.order_id where o.merchant_id = ${c.m.merchantId} and o.status in ${c.db.sql(LIVE)} and c.total - c.paid_total > 0 order by c.id`);
    if (!ch) return null;
    const pay = (body: Record<string, unknown>) => c.call("POST", `/v1/checks/${ch.id}/payments`, { token: c.pin, body: { payment_id: randomUUID(), ...body } });
    if (g.chance(0.5)) {
      const tip = g.chance(0.3) ? c.increment * g.int(1, 5) : 0;
      const mode = g.int(0, 3);
      if (mode === 0) return pay({ tender_type_id: c.cash, amount: g.int(1, ch.balance), tip_cents: tip || undefined });
      if (mode === 1) return pay({ tender_type_id: c.cash, amount: ch.balance + g.int(1, 5000), tip_cents: tip || undefined });
      return pay({ tender_type_id: c.cash, amount: ch.balance, tendered: ch.balance + c.increment + g.int(0, 9000) + tip, tip_cents: tip || undefined });
    }
    return pay({ tender_type_id: c.card, amount: g.chance(0.6) ? ch.balance : g.int(1, ch.balance), tip_cents: g.chance(0.3) ? g.int(1, 500) : undefined });
  } },
  { name: "void-payment", w: 2, run: async (c, g) => {
    const p = pickRow(g, await c.db.sql<{ id: string }[]>`select id from payments where merchant_id = ${c.m.merchantId} and status = 'recorded' order by id`);
    return p ? c.call("POST", `/v1/payments/${p.id}/void`, { token: c.pin, body: { reason: "fz" } }) : null;
  } },
  { name: "refund-units", w: 2, run: async (c, g) => {
    const a = pickRow(g, await c.db.sql<{ check_id: string; order_line_id: string }[]>`select a.check_id, a.order_line_id from check_allocations a join checks c on c.id = a.check_id join order_lines l on l.id = a.order_line_id where c.merchant_id = ${c.m.merchantId} and c.locked_at is not null and a.share_num = a.share_den and l.quantity > 1 and c.paid_total >= c.total order by a.check_id, a.order_line_id`);
    return a ? c.call("POST", `/v1/checks/${a.check_id}/refunds`, { token: c.pin, body: { refund_id: randomUUID(), request: { kind: "lines", lines: [{ line_id: a.order_line_id, quantity: 1 }] }, reason: "fz", print: false } }) : null;
  } },
  { name: "refund", w: 4, run: async (c, g) => {
    const ch = pickRow(g, await c.db.sql<{ id: string; left: number }[]>`select id, paid_total - refunded_total as left from checks where merchant_id = ${c.m.merchantId} and locked_at is not null and paid_total > refunded_total order by id`);
    if (!ch) return null;
    const mode = g.int(0, 2);
    let request: Record<string, unknown> = { kind: "full" };
    if (mode === 1) {
      const a = pickRow(g, await c.db.sql<{ order_line_id: string; quantity: number }[]>`select a.order_line_id, l.quantity from check_allocations a join order_lines l on l.id = a.order_line_id where a.check_id = ${ch.id} order by a.order_line_id`);
      if (!a) return null;
      request = { kind: "lines", lines: [{ line_id: a.order_line_id, quantity: g.chance(0.6) ? 1 : g.int(1, a.quantity) }] };
    } else if (mode === 2) request = { kind: "amount", amount: g.chance(0.3) ? g.int(1, 9) : g.int(1, Math.max(1, ch.left)) };
    let tender_split: { payment_id: string; amount: number }[] | undefined;
    if (g.chance(0.25)) {
      // Adversarial: everything onto one payment, named twice.
      const q = await c.call<{ data: { totals: { total: number } } }>("POST", `/v1/checks/${ch.id}/refunds/quote`, { token: c.pin, body: { request } });
      const p = pickRow(g, await c.db.sql<{ id: string }[]>`select id from payments where check_id = ${ch.id} and status = 'recorded' order by id`);
      if (q.status === 200 && p) {
        const t = q.body.data.totals.total;
        tender_split = [{ payment_id: p.id, amount: Math.floor(t / 2) }, { payment_id: p.id, amount: t - Math.floor(t / 2) }];
      }
    }
    return c.call("POST", `/v1/checks/${ch.id}/refunds`, { token: c.pin, body: { refund_id: randomUUID(), request, tender_split, reason: "fz", print: false } });
  } },
  { name: "reopen", w: 1, run: async (c, g) => {
    const o = pickRow(g, await c.db.sql<{ id: string }[]>`select id from orders where merchant_id = ${c.m.merchantId} and status = 'completed' order by id`);
    return o ? c.call("POST", `/v1/orders/${o.id}/reopen`, { token: c.pin, body: { reason: "fz" } }) : null;
  } },
  { name: "complete", w: 1, run: async (c, g) => {
    const o = await liveOrder(c, g);
    return o ? c.call("POST", `/v1/orders/${o}/complete`, { token: c.pin, body: {} }) : null;
  } },
  { name: "change-type", w: 1, run: async (c, g) => {
    const o = await liveOrder(c, g);
    return o ? c.call("POST", `/v1/orders/${o}/change-type`, { token: c.pin, body: { order_type: "takeaway" } }) : null;
  } },
  { name: "cancel", w: 1, run: async (c, g) => {
    const o = await liveOrder(c, g);
    return o ? c.call("POST", `/v1/orders/${o}/cancel`, { token: c.pin, body: { reason: "fz" } }) : null;
  } },
];

async function runRegime(r: Regime, seed: number, db: TestDb) {
  const g = rng(seed * 7919 + r.key.charCodeAt(0));
  const c = await buildWorld(r, db);
  const violations: string[] = [];
  const total = sum(actions.map((a) => a.w));
  let applied = 0;
  for (let step = 0; step < STEPS && violations.length < 10; step++) {
    let x = g.f() * total;
    const a = actions.find((a) => (x -= a.w) < 0)!;
    const res = await a.run(c, g);
    if (res && res.status >= 500) violations.push(`step ${step} ${a.name}: ${res.status} ${JSON.stringify(res.body)}`);
    if (res && res.status < 300) applied++;
    for (const msg of await invariants(c)) violations.push(`step ${step} ${a.name}: ${msg}`);
    if (step % 10 === 9 || step === STEPS - 1) for (const msg of await reports(c)) violations.push(`step ${step} reports: ${msg}`);
  }
  // Close the shift with exactly the cash the rows say is there: the register must agree.
  const [rows] = await db.sql<{ n: number }[]>`
    select (${c.float}::bigint
      + coalesce((select sum(amount + rounding_cents + tip_cents) from payments where shift_id = ${c.shiftId} and status = 'recorded' and is_cash), 0)
      - coalesce((select sum(t.amount + t.rounding_cents) from refund_tenders t join refunds f on f.id = t.refund_id where f.shift_id = ${c.shiftId} and t.is_cash), 0))::bigint as n`;
  const close = await c.call<{ data: { variance_cents: number } }>("POST", `/v1/shifts/${c.shiftId}/close`, { token: c.admin, body: { counted_cash_cents: rows!.n, variance_reason: "fuzz" } });
  if (close.status !== 200) violations.push(`shift close ${close.status} ${JSON.stringify(close.body)}`);
  else if (close.body.data.variance_cents !== 0) violations.push(`shift closed at variance ${close.body.data.variance_cents} with the rows' cash counted`);
  return { violations, applied };
}

describe("money fuzz", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(async () => db?.drop());
  for (const r of REGIMES)
    for (const seed of SEEDS)
      it(`regime ${r.key}, seed ${seed}: ${STEPS} steps keep every money invariant`, { timeout: 600_000 }, async () => {
        const { violations, applied } = await runRegime(r, seed, db);
        expect(violations).toEqual([]);
        // The walk did something: a fuzzer whose every step is refused proves nothing.
        expect(applied).toBeGreaterThan(STEPS / 4);
      });
});
