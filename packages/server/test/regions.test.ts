import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REGION_PRESETS, type TaxBreakdown } from "@sail/shared";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { presetSettings } from "../src/bootstrap.js";
import { withTransaction } from "../src/db/client.js";
import { businessDayInputs } from "../src/services/business-day.js";
import { businessDateFor, nextCutoff, zonedToUtc } from "../src/lib/time.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

/**
 * A merchant outside Singapore: an EU café on inclusive VAT at two rates in
 * EUR and Europe/Berlin, a Japanese merchant in yen, and business days in
 * zones with daylight saving time.
 */
let db: TestDb;
let app: App;
let EU: SeededMerchant;
let JP: SeededMerchant;
let call: ReturnType<typeof api>["call"];

const ids = { schnitzel: randomUUID(), pils: randomUUID(), bretzel: randomUUID(), schnaps: randomUUID(), menu: randomUUID(), link: randomUUID(), area: randomUUID(), table: randomUUID(), table2: randomUUID(), table3: randomUUID(), station: randomUUID(), card: randomUUID(), printer: randomUUID(), takeawayClass: randomUUID() };
let stationToken: string;
let cashierPin: string;

type Snap = { id: string; business_date: string; totals: { tax_mode: string; tax_rounding: string; tax_total: number; taxes: TaxBreakdown[]; total: number }; lines: { id: string; tax_class_id: string; amounts: { tax: number }; taxes: TaxBreakdown[] }[]; checks: { id: string; totals: { total: number; tax_total: number; taxes: { name: string; amount: number }[] } }[] };
type Mut = { data: Snap; code?: string };

beforeAll(async () => {
  db = await freshDb();
  app = buildApp();
  call = api(app).call;
  EU = await seedMerchant(db.sql, "Kanal", { preset: "eu-vat", timeZone: "Europe/Berlin", locale: "de-DE" });
  JP = await seedMerchant(db.sql, "Kissa", { preset: "jp", timeZone: "Asia/Tokyo" });
  const t = EU.admin.token;
  await call("POST", "/v1/products", { token: t, body: { id: ids.schnitzel, name: "Schnitzel", price: 1690, tags: ["kitchen"], tax_class_id: EU.taxClassIds.reduced } });
  await call("POST", "/v1/products", { token: t, body: { id: ids.pils, name: "Pils", price: 490, tags: ["bar"] } });
  await call("POST", "/v1/tax-classes", { token: t, body: { id: ids.takeawayClass, name: "Bakery", components: [{ name: "VAT 20%", bps: 2000 }] } });
  await call("PUT", `/v1/tax-classes/${ids.takeawayClass}/rates`, { token: t, body: { outlet_id: null, order_type: "takeaway", components: [{ name: "VAT 10%", bps: 1000 }] } });
  await call("POST", "/v1/products", { token: t, body: { id: ids.bretzel, name: "Brezel", price: 350, tags: ["kitchen"], tax_class_id: ids.takeawayClass } });
  await call("POST", "/v1/products", { token: t, body: { id: ids.schnaps, name: "Obstler", price: 500, tags: ["bar"] } });
  await call("POST", "/v1/menus", { token: t, body: { id: ids.menu, brand_id: EU.brandId, name: "Tageskarte", sections: [{ name: "Alles", items: [{ product_id: ids.schnitzel }, { product_id: ids.pils }, { product_id: ids.bretzel }, { product_id: ids.schnaps }] }] } });
  await call("POST", "/v1/channel-links", { token: t, body: { id: ids.link, channel: "pos", outlet_id: EU.outletId, brand_id: EU.brandId, menu_id: ids.menu } });
  await call("POST", "/v1/areas", { token: t, body: { id: ids.area, outlet_id: EU.outletId, name: "Gastraum" } });
  for (const [id, name] of [[ids.table, "1"], [ids.table2, "2"], [ids.table3, "3"]] as const) await call("POST", "/v1/tables", { token: t, body: { id, outlet_id: EU.outletId, area_id: ids.area, name } });
  await call("POST", "/v1/tender-types", { token: t, body: { id: ids.card, name: "Karte", is_terminal: true } });
  await call("POST", "/v1/printers", { token: t, body: { id: ids.printer, outlet_id: EU.outletId, name: "Bon", ip: "10.0.0.9", role: "receipt" } });
  await call("PATCH", `/v1/outlets/${EU.outletId}`, { token: t, body: { business_registration_no: "HRB 123456 B", tax_registration_no: "DE123456789" } });
  await call("POST", "/v1/stations", { token: t, body: { id: ids.station, outlet_id: EU.outletId, brand_id: EU.brandId, name: "Kasse", receipt_printer_id: ids.printer } });
  const code = await call<{ data: { code: string } }>("POST", `/v1/stations/${ids.station}/pairing-code`, { token: t, body: {} });
  stationToken = (await call<{ data: { station_token: string } }>("POST", "/v1/stations/pair", { body: { code: code.body.data.code, device_label: "iPad" }, idempotencyKey: null })).body.data.station_token;
  cashierPin = (await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: stationToken, body: { pin: "333333" } })).body.data.session_token;
});
afterAll(async () => {
  await db.drop();
});

const open = (body: Record<string, unknown>) => call<Mut>("POST", "/v1/orders", { token: cashierPin, body: { order_id: randomUUID(), ...body } });
const addLines = (orderId: string, lines: { product_id: string; quantity: number }[]) => call<Mut>("POST", `/v1/orders/${orderId}/lines`, { token: cashierPin, body: { lines: lines.map((l) => ({ line_id: randomUUID(), ...l })) } });

describe("business days in zones with daylight saving time", () => {
  it("New York: the day the clocks go back is 25 hours long; the cutoff stays at 04:00 local on both sides", () => {
    // DST ends Sunday 1 Nov 2026 at 02:00 EDT (06:00Z): 04:00 on 31 Oct is EDT (UTC−4), 04:00 on 1 Nov is EST (UTC−5).
    expect(zonedToUtc("2026-10-31", "04:00", "America/New_York").toISOString()).toBe("2026-10-31T08:00:00.000Z");
    expect(zonedToUtc("2026-11-01", "04:00", "America/New_York").toISOString()).toBe("2026-11-01T09:00:00.000Z");
    expect(nextCutoff(new Date("2026-10-31T12:00:00Z"), "04:00", "America/New_York").toISOString()).toBe("2026-11-01T09:00:00.000Z");
    // 03:30 EST on 1 Nov (08:30Z) still belongs to 31 Oct; 04:30 EST (09:30Z) is the new day.
    expect(businessDateFor(new Date("2026-11-01T08:30:00Z"), "04:00", "America/New_York")).toBe("2026-10-31");
    expect(businessDateFor(new Date("2026-11-01T09:30:00Z"), "04:00", "America/New_York")).toBe("2026-11-01");
    // The hour that repeats (01:30 EDT, then 01:30 EST) is the same business day both times.
    expect(businessDateFor(new Date("2026-11-01T05:30:00Z"), "04:00", "America/New_York")).toBe("2026-10-31");
    expect(businessDateFor(new Date("2026-11-01T06:30:00Z"), "04:00", "America/New_York")).toBe("2026-10-31");
  });

  it("New York: the day the clocks go forward is 23 hours long", () => {
    // DST starts Sunday 8 Mar 2026 at 02:00 EST: 04:00 on 7 Mar is EST (09:00Z), 04:00 on 8 Mar is EDT (08:00Z).
    expect(zonedToUtc("2026-03-07", "04:00", "America/New_York").toISOString()).toBe("2026-03-07T09:00:00.000Z");
    expect(zonedToUtc("2026-03-08", "04:00", "America/New_York").toISOString()).toBe("2026-03-08T08:00:00.000Z");
    expect(businessDateFor(new Date("2026-03-08T07:59:00Z"), "04:00", "America/New_York")).toBe("2026-03-07");
    expect(businessDateFor(new Date("2026-03-08T08:00:00Z"), "04:00", "America/New_York")).toBe("2026-03-08");
  });

  it("Berlin: cutoffs either side of the October and March changes", () => {
    // CEST (UTC+2) ends Sunday 25 Oct 2026 at 03:00; CET is UTC+1. CEST starts Sunday 29 Mar 2026 at 02:00.
    expect(zonedToUtc("2026-10-24", "04:00", "Europe/Berlin").toISOString()).toBe("2026-10-24T02:00:00.000Z");
    expect(zonedToUtc("2026-10-25", "04:00", "Europe/Berlin").toISOString()).toBe("2026-10-25T03:00:00.000Z");
    expect(nextCutoff(new Date("2026-10-24T12:00:00Z"), "04:00", "Europe/Berlin").toISOString()).toBe("2026-10-25T03:00:00.000Z");
    expect(businessDateFor(new Date("2026-10-25T02:30:00Z"), "04:00", "Europe/Berlin")).toBe("2026-10-24");
    expect(businessDateFor(new Date("2026-10-25T03:00:00Z"), "04:00", "Europe/Berlin")).toBe("2026-10-25");
    expect(zonedToUtc("2026-03-29", "04:00", "Europe/Berlin").toISOString()).toBe("2026-03-29T02:00:00.000Z");
    expect(businessDateFor(new Date("2026-03-29T01:59:00Z"), "04:00", "Europe/Berlin")).toBe("2026-03-28");
    expect(businessDateFor(new Date("2026-03-29T02:00:00Z"), "04:00", "Europe/Berlin")).toBe("2026-03-29");
  });

  it("orders take their business date from the merchant's zone", async () => {
    const o = await open({ order_type: "takeaway" });
    expect(o.status).toBe(201);
    const opened = new Date();
    expect([businessDateFor(new Date(opened.getTime() - 60_000), "04:00", "Europe/Berlin"), businessDateFor(opened, "04:00", "Europe/Berlin")]).toContain(o.body.data.business_date);
    expect(await withTransaction(() => businessDayInputs(EU.merchantId, EU.outletId))).toEqual({ cutoff: "04:00", timeZone: "Europe/Berlin" });
  });
});

describe("a merchant without a time zone, currency or locale is refused, never defaulted", () => {
  it("at creation", () => {
    expect(() => presetSettings(REGION_PRESETS.sg, { timeZone: "" })).toThrow(/time zone/);
    expect(() => presetSettings(REGION_PRESETS.us, { timeZone: "America/Atlantis" })).toThrow(/time zone/);
    expect(() => presetSettings(REGION_PRESETS.blank, { timeZone: "Europe/Zurich" })).toThrow(/currency/);
    expect(() => presetSettings(REGION_PRESETS.blank, { timeZone: "Europe/Zurich", currency: "CHF" })).toThrow(/locale/);
    expect(presetSettings(REGION_PRESETS.blank, { timeZone: "Europe/Zurich", currency: "CHF", locale: "de-CH", cashRoundingIncrement: 5 })).toMatchObject({ currency: "CHF", locale: "de-CH", cashRounding: 5 });
  });
  it("when changing settings", async () => {
    expect((await call("PATCH", "/v1/merchant/settings", { token: EU.admin.token, body: { timezone: "Mars/Olympus" } })).status).toBe(400);
  });
});

describe("EU VAT: inclusive prices at two rates, rounded once per rate", () => {
  it("the merchant's settings carry the currency, its exponent, the locale and the cash counter's denominations, readable by the POS", async () => {
    const m = await call<{ data: { settings: Record<string, unknown> } }>("GET", "/v1/merchant", { token: cashierPin });
    expect(m.status).toBe(200);
    expect(m.body.data.settings).toMatchObject({ currency: "EUR", currency_exponent: 2, locale: "de-DE", timezone: "Europe/Berlin", tax_mode: "inclusive", tax_rounding: "per_rate", cash_denominations: REGION_PRESETS["eu-vat"].cash_denominations, tax_registration_label: "VAT no." });
    const jp = await call<{ data: { settings: Record<string, unknown> } }>("GET", "/v1/merchant", { token: JP.admin.token });
    expect(jp.body.data.settings).toMatchObject({ currency: "JPY", currency_exponent: 0, locale: "ja-JP", cash_denominations: [10_000, 5000, 1000, 500, 100, 50, 10, 5, 1] });
  });

  it("a mixed bill reports VAT 10% and VAT 20% separately; split in two, the bills add up per rate", async () => {
    const o = await open({ order_type: "dine_in", table_id: ids.table, pax: 2 });
    const r = await addLines(o.body.data.id, [{ product_id: ids.schnitzel, quantity: 1 }, { product_id: ids.pils, quantity: 2 }]);
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    const s = r.body.data;
    // 1690 × 10/110 = 153.64 → 154; 980 × 20/120 = 163.33 → 163. Inclusive: the total is the menu prices.
    expect(s.totals).toMatchObject({ tax_mode: "inclusive", tax_rounding: "per_rate", tax_total: 317, total: 2670 });
    expect(s.totals.taxes).toEqual([
      { name: "VAT 10%", bps: 1000, taxable: 1690 - 154, amount: 154 },
      { name: "VAT 20%", bps: 2000, taxable: 980 - 163, amount: 163 },
    ]);
    expect(s.lines.find((l) => l.tax_class_id === EU.taxClassIds.reduced)!.amounts.tax).toBe(154);

    const split = await call<Mut>("POST", `/v1/orders/${o.body.data.id}/checks/split-even`, { token: cashierPin, body: { n: 2 } });
    expect(split.status).toBe(200);
    const bills = split.body.data.checks;
    expect(bills).toHaveLength(2);
    expect(bills.reduce((a, b) => a + b.totals.total, 0)).toBe(2670);
    for (const name of ["VAT 10%", "VAT 20%"]) expect(bills.reduce((a, b) => a + b.totals.taxes.find((t) => t.name === name)!.amount, 0)).toBe(name === "VAT 10%" ? 154 : 163);
    for (const b of bills) expect(b.totals.tax_total).toBe(b.totals.taxes.reduce((a, t) => a + t.amount, 0));

    // The pre-bill prints each rate under its own name, in euros, with the outlet's registration numbers.
    const pre = await call("POST", `/v1/orders/${o.body.data.id}/prebill`, { token: cashierPin, body: { check_id: bills[0]!.id } });
    expect(pre.status).toBe(200);
    const jobs = await call<{ data: { kind: string; text: string }[] }>("GET", `/v1/outlets/${EU.outletId}/print-jobs?order_id=${o.body.data.id}`, { token: cashierPin });
    const text = jobs.body.data.find((j) => j.kind === "prebill")!.text;
    expect(text).toMatch(/VAT 10% \(included\)/);
    expect(text).toMatch(/VAT 20% \(included\)/);
    expect(text).toMatch(/€/);
    expect(text).toMatch(/VAT no\. DE123456789/);
    expect(text).toMatch(/Company reg\. no\. HRB 123456 B/);
    expect(text).not.toMatch(/GST|UEN/);
  });

  it("a rate that depends on the order type: the bakery class is 20% to eat in and 10% to take away", async () => {
    const dineIn = await open({ order_type: "dine_in", table_id: ids.table2, pax: 1 });
    const inside = await addLines(dineIn.body.data.id, [{ product_id: ids.bretzel, quantity: 1 }]);
    expect(inside.body.data.totals.taxes).toEqual([{ name: "VAT 20%", bps: 2000, taxable: 292, amount: 58 }]); // 350 × 20/120 = 58.33
    const away = await open({ order_type: "takeaway" });
    const out = await addLines(away.body.data.id, [{ product_id: ids.bretzel, quantity: 1 }]);
    expect(out.body.data.totals.taxes).toEqual([{ name: "VAT 10%", bps: 1000, taxable: 318, amount: 32 }]); // 350 × 10/110 = 31.82
    // Changing the order type re-prices at the other rate.
    const changed = await call<Mut>("POST", `/v1/orders/${away.body.data.id}/change-type`, { token: cashierPin, body: { order_type: "dine_in", table_id: ids.table3, pax: 1 } });
    expect(changed.status, JSON.stringify(changed.body).slice(0, 300)).toBe(200);
    expect(changed.body.data.totals.taxes.map((t) => t.name)).toEqual(["VAT 20%"]);
  });

  it("a tax class created after an order opened is added to that order's tax table when one of its products is ordered", async () => {
    const o = await open({ order_type: "takeaway" });
    expect((await addLines(o.body.data.id, [{ product_id: ids.pils, quantity: 1 }])).status).toBe(200);
    const spirits = randomUUID();
    expect((await call("POST", "/v1/tax-classes", { token: EU.admin.token, body: { id: spirits, name: "Spirits", components: [{ name: "VAT 25%", bps: 2500 }] } })).status).toBe(201);
    expect((await call("PATCH", `/v1/products/${ids.schnaps}`, { token: EU.admin.token, body: { tax_class_id: spirits } })).status).toBe(200);
    const r = await addLines(o.body.data.id, [{ product_id: ids.schnaps, quantity: 1 }]);
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    // 490 × 20/120 = 81.67 → 82; 500 × 25/125 = 100.
    expect(r.body.data.totals.taxes).toEqual([
      { name: "VAT 20%", bps: 2000, taxable: 408, amount: 82 },
      { name: "VAT 25%", bps: 2500, taxable: 400, amount: 100 },
    ]);
  });

  it("tax classes and rates are managed through the API; the default rate and the default class are protected", async () => {
    const list = await call<{ data: { id: string; name: string; is_default: boolean; rates: { id: string; outlet_id: string | null; order_type: string | null }[] }[] }>("GET", "/v1/tax-classes", { token: cashierPin });
    expect(list.status).toBe(200);
    expect(list.body.data.map((c) => c.name).sort()).toEqual(["Bakery", "Exempt", "Reduced rate", "Spirits", "Standard rate"]);
    const bakery = list.body.data.find((c) => c.id === ids.takeawayClass)!;
    expect(bakery.rates).toHaveLength(2);
    const base = bakery.rates.find((r) => r.order_type == null)!;
    expect((await call("DELETE", `/v1/tax-classes/${ids.takeawayClass}/rates/${base.id}`, { token: EU.admin.token })).status).toBe(409);
    const std = list.body.data.find((c) => c.is_default)!;
    expect((await call("PATCH", `/v1/tax-classes/${std.id}`, { token: EU.admin.token, body: { archived: true } })).status).toBe(409);
    expect((await call("PATCH", `/v1/tax-classes/${ids.takeawayClass}`, { token: EU.admin.token, body: { archived: true } })).status).toBe(409); // the Brezel uses it
    expect((await call("POST", "/v1/tax-classes", { token: EU.manager.token, body: { name: "x", components: [] } })).status).toBe(403);
    // An archived class cannot become the default, and a rate cannot name another merchant's outlet.
    const old = randomUUID();
    await call("POST", "/v1/tax-classes", { token: EU.admin.token, body: { id: old, name: "Old", components: [] } });
    expect((await call("PATCH", `/v1/tax-classes/${old}`, { token: EU.admin.token, body: { archived: true } })).status).toBe(200);
    expect((await call("PATCH", `/v1/tax-classes/${old}`, { token: EU.admin.token, body: { is_default: true } })).status).toBe(409);
    expect((await call("PUT", `/v1/tax-classes/${ids.takeawayClass}/rates`, { token: EU.admin.token, body: { outlet_id: JP.outletId, order_type: null, components: [] } })).status).toBe(404);
    // A product cannot name another merchant's class.
    expect((await call("POST", "/v1/products", { token: EU.admin.token, body: { name: "Fremd", price: 100, tax_class_id: JP.taxClassIds.food } })).status).toBe(400);
  });
});
