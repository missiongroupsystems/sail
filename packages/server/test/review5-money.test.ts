import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { pdfStrings } from "./pdf-strings.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

/** Fifth review round, money: a US diner (4% state + 4.5% local) and an EU café (VAT 10% and 20% inside the price). */
let db: TestDb;
let app: App;
let call: ReturnType<typeof api>["call"];

type Tax = { name: string; bps: number; amount: number };
type Snap = {
  id: string;
  version: number;
  status: string;
  totals: { subtotal: number; tax_total: number; taxes: Tax[]; total: number };
  lines: { id: string; product_id: string; name: string; status: string }[];
  checks: { id: string; label: string; locked: boolean; status: string; invoice_no: string | null; totals: { total: number; taxes: Tax[] }; balance: number; paid_total: number }[];
  balance: number;
};
type Err = { message: string; remedy?: string; details: Record<string, unknown> };
type Mut = { data: Snap } & Err;
type Tender = { payment_id: string; is_cash: boolean; amount: number; rounding_cents: number; tip_cents: number };
type RefundRes = { data: Snap; refund: { id: string; totals: { total: number; taxes: Tax[] }; credit_note_no: string | null; quote: { tenders: Tender[]; cash_out: number } } } & Err;

type World = { m: SeededMerchant; cash: string; card: string; products: Record<string, string>; stations: { id: string; pin: string }[] };

async function world(name: string, preset: "us" | "eu-vat", products: { key: string; price: number; taxClass: string }[]): Promise<World> {
  const m = await seedMerchant(db.sql, name, preset === "us" ? { preset, timeZone: "America/New_York", locale: "en-US" } : { preset, timeZone: "Europe/Berlin", currency: "EUR", locale: "de-DE" });
  const t = m.admin.token;
  const must = async (path: string, body: unknown) => {
    const r = await call<{ data: { url?: string } }>("POST", path, { token: t, body });
    expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
    return r.body.data;
  };
  const ids: Record<string, string> = {};
  for (const p of products) {
    ids[p.key] = randomUUID();
    await must("/v1/products", { id: ids[p.key], name: p.key, price: p.price, tax_class_id: m.taxClassIds[p.taxClass] });
  }
  const menu = randomUUID();
  await must("/v1/menus", { id: menu, brand_id: m.brandId, name: "M", sections: [{ name: "All", items: Object.values(ids).map((product_id) => ({ product_id })) }] });
  await must("/v1/channel-links", { id: randomUUID(), channel: "pos", outlet_id: m.outletId, brand_id: m.brandId, menu_id: menu });
  const cash = randomUUID();
  const card = randomUUID();
  await must("/v1/tender-types", { id: cash, name: "Cash", is_cash: true });
  await must("/v1/tender-types", { id: card, name: "Card" });
  const stations: World["stations"] = [];
  for (const [label, pin] of [["Station 1", "333333"], ["Station 2", "222222"]] as const) {
    const id = randomUUID();
    await must("/v1/stations", { id, outlet_id: m.outletId, brand_id: m.brandId, name: label });
    const code = await call<{ data: { code: string } }>("POST", `/v1/stations/${id}/pairing-code`, { token: t, body: {} });
    const paired = await call<{ data: { station_token: string } }>("POST", "/v1/stations/pair", { body: { code: code.body.data.code, device_label: "iPad" }, idempotencyKey: null });
    const session = (await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: paired.body.data.station_token, body: { pin } })).body.data.session_token;
    stations.push({ id, pin: session });
  }
  return { m, cash, card, products: ids, stations };
}

let US: World;
let EU: World;

beforeAll(async () => {
  db = await freshDb();
  app = buildApp();
  call = api(app).call;
  // Reviewer A's and B's baskets, at the demo menu's prices (a burger with bacon keyed as one product).
  US = await world("Diner", "us", [
    { key: "veggie", price: 1249, taxClass: "prepared_food" },
    { key: "classicBacon", price: 1449, taxClass: "prepared_food" },
    { key: "salad", price: 899, taxClass: "prepared_food" },
    { key: "beer", price: 699, taxClass: "prepared_food" },
    { key: "water", price: 199, taxClass: "exempt" },
    { key: "soda", price: 249, taxClass: "prepared_food" },
    { key: "cheeseBacon", price: 1549, taxClass: "prepared_food" },
    { key: "rings", price: 549, taxClass: "prepared_food" },
    { key: "coffee", price: 279, taxClass: "prepared_food" },
    { key: "tea", price: 299, taxClass: "prepared_food" },
  ]);
  EU = await world("Café", "eu-vat", [
    { key: "sandwich", price: 850, taxClass: "reduced" },
    { key: "wine", price: 750, taxClass: "standard" },
    { key: "tea", price: 300, taxClass: "standard" },
    { key: "quiche", price: 1150, taxClass: "reduced" },
    { key: "scone", price: 350, taxClass: "reduced" },
    { key: "flatOat", price: 420, taxClass: "standard" },
    { key: "juice", price: 400, taxClass: "standard" },
    { key: "cake", price: 495, taxClass: "reduced" },
  ]);
  // "A5-Test Service 10%": a manual fee on every line, taxed as prepared food (US) or at 20% VAT (café).
  for (const [w, cls] of [[US, "prepared_food"], [EU, "standard"]] as const) {
    const r = await call("POST", "/v1/pricing-rules", { token: w.m.admin.token, body: { rule_key: "svc10", body: { kind: "fee", name: "Service 10%", calc: "percent", value: { type: "fixed", amount: 1000 }, scope: { type: "all" }, priority: 900, application: "manual", min_role: "manager", tax_class_id: w.m.taxClassIds[cls], report_class: "service_charge" } } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
});
afterAll(async () => {
  await db.drop();
});

const pos = (w: World, i = 0) => w.stations[i]!.pin;
const open = (w: World, i = 0) => call<Mut>("POST", "/v1/orders", { token: pos(w, i), body: { order_id: randomUUID(), order_type: "takeaway", takeaway_ref: "T" } });
const add = (w: World, orderId: string, keys: string[], i = 0) => call<Mut>("POST", `/v1/orders/${orderId}/lines`, { token: pos(w, i), body: { lines: keys.map((k) => ({ line_id: randomUUID(), product_id: w.products[k], quantity: 1 })) } });
const cancel = async (w: World, id: string) => expect((await call("POST", `/v1/orders/${id}/cancel`, { token: w.m.manager.token, body: { reason: "test" } })).status).toBeLessThan(300);

type Bill = { id: string; label: string; tax_note: string | null; totals: { subtotal: number; discount_total: number; fee_total: number; taxes: Tax[]; total: number } };
async function feeOrder(w: World, keys: string[]) {
  const o = await open(w, 1);
  const s = await add(w, o.body.data.id, keys, 1);
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  const applied = await call<Mut>("POST", `/v1/orders/${o.body.data.id}/adjustments`, { token: w.m.manager.token, body: { application_id: randomUUID(), rule_key: "svc10", reason: "Party" } });
  expect(applied.status, JSON.stringify(applied.body)).toBeLessThan(300);
  return applied.body.data;
}
async function allocate(w: World, orderId: string, moves: { line_id: string; check_ids: string[] }[], addChecks = 0) {
  const r = await call<Mut>("POST", `/v1/orders/${orderId}/checks/allocate`, { token: w.m.manager.token, body: { moves, add_checks: addChecks } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data as unknown as Omit<Snap, "checks"> & { checks: Bill[] };
}
/** Move the named lines (by product key) to Bill 2, the rest stay on Bill 1. */
async function byItem(w: World, o: Snap, toBill2: string[]) {
  const now = (await call<{ data: Snap }>("GET", `/v1/orders/${o.id}`, { token: w.m.manager.token })).body.data;
  let snap = await allocate(w, o.id, [], now.checks.length < 2 ? 1 : 0);
  const b2 = snap.checks[1]!.id;
  const ids = o.lines.filter((l) => toBill2.some((k) => w.products[k] === l.product_id)).map((l) => l.id);
  snap = await allocate(w, o.id, ids.map((line_id) => ({ line_id, check_ids: [b2] })));
  return snap;
}
const rate = (b: Bill, name: string) => b.totals.taxes.find((t) => t.name.includes(name))?.amount ?? 0;

/** The note is on a bill exactly when one of its rates is not that bill's own rounding. */
function expectNotes(bills: Bill[], own: Record<string, number>[], label: string) {
  bills.forEach((b, i) => {
    const off = Object.entries(own[i]!).filter(([name, v]) => rate(b, name) !== v);
    expect(b.tax_note !== null, `${label}, ${b.label}: ${JSON.stringify(b.totals.taxes)} own ${JSON.stringify(own[i])} note ${b.tax_note}`).toBe(off.length > 0);
  });
}

describe("V1: split bills with a service fee keep each bill's own rounding when it adds up", () => {
  it("US, A's P-0004: salad alone on Bill 2 is $1.61 / $0.40 state and $1.81 / $0.45 local, with no note", async () => {
    const o = await feeOrder(US, ["veggie", "classicBacon", "salad", "beer", "water", "soda"]);
    expect(o.totals.total).toBe(5646);
    expect(o.totals.taxes.map((t) => t.amount)).toEqual([201, 226]);
    const s = await byItem(US, o, ["salad"]);
    const [b1, b2] = s.checks;
    // Taxable: Bill 1 $40.31 (its $42.30 less the untaxed water), Bill 2 $9.89.
    expect([b1!.totals.subtotal + b1!.totals.fee_total - 199, b2!.totals.subtotal + b2!.totals.fee_total]).toEqual([4031, 989]);
    expect([rate(b1!, "State"), rate(b2!, "State")]).toEqual([161, 40]);
    expect([rate(b1!, "Local"), rate(b2!, "Local")]).toEqual([181, 45]);
    expect([b1!.tax_note, b2!.tax_note]).toEqual([null, null]);
    expect(b1!.totals.total + b2!.totals.total).toBe(5646);
    // Then beer and soda as well: $1.20 / $0.81 and $1.35 / $0.91, as before; the note only where a cent was needed.
    const t = await byItem(US, o, ["salad", "beer", "soda"]);
    const own = t.checks.map((b) => {
      const taxable = b.totals.subtotal + b.totals.discount_total + b.totals.fee_total - (b.label === "Bill 1" ? 199 : 0);
      return { State: Math.floor((taxable * 400 + 5000) / 10000), Local: Math.floor((taxable * 450 + 5000) / 10000) };
    });
    expect(t.checks.map((b) => rate(b, "State")).reduce((a, b) => a + b, 0)).toBe(201);
    expect(t.checks.map((b) => rate(b, "Local")).reduce((a, b) => a + b, 0)).toBe(226);
    expectNotes(t.checks, own, "beer + soda + salad");
    await cancel(US, o.id);
  });

  it("US, B's fee order: veggie, salad, water | beer, water is $1.07 / $0.36 local with no note", async () => {
    const o = await feeOrder(US, ["veggie", "salad", "water", "beer", "water"]);
    const beerLine = o.lines.find((l) => l.product_id === US.products.beer)!.id;
    const water2 = o.lines.filter((l) => l.product_id === US.products.water)[1]!.id;
    let s = await allocate(US, o.id, [], 1);
    s = await allocate(US, o.id, [beerLine, water2].map((line_id) => ({ line_id, check_ids: [s.checks[1]!.id] })));
    const [b1, b2] = s.checks;
    expect([b1!.totals.subtotal + b1!.totals.fee_total - 199, b2!.totals.subtotal + b2!.totals.fee_total - 199]).toEqual([2383, 789]);
    expect([rate(b1!, "Local"), rate(b2!, "Local")]).toEqual([107, 36]);
    expect([rate(b1!, "State"), rate(b2!, "State")]).toEqual([95, 32]);
    expect([b1!.tax_note, b2!.tax_note]).toEqual([null, null]);
    await cancel(US, o.id);
  });

  it("café, A's P-0005: each step of the split has notes only where a cent was needed; the final split is €0.77 / €2.07 and €1.37 / €1.75", async () => {
    const o = await feeOrder(EU, ["sandwich", "wine", "tea", "quiche", "scone", "flatOat", "juice"]);
    expect(o.totals.total).toBe(4642);
    expect(o.totals.taxes.map((t) => [t.name, t.amount])).toEqual(expect.arrayContaining([["VAT 10%", 214], ["VAT 20%", 382]]));
    const inc = (gross: number, bps: number) => Math.floor((gross * bps) / (10000 + bps) + 0.5);
    // Gross amounts at each rate on Bill 2 for each step; fee 10% of each line at 20%.
    const price: Record<string, number> = { sandwich: 850, wine: 750, tea: 300, quiche: 1150, scone: 350, flatOat: 420, juice: 400 };
    const reduced = new Set(["sandwich", "quiche", "scone"]);
    const fee = (k: string) => Math.round(price[k]! / 10);
    const ownOf = (keys: string[]) => ({ "VAT 10%": inc(keys.filter((k) => reduced.has(k)).reduce((n, k) => n + price[k]!, 0), 1000), "VAT 20%": inc(keys.filter((k) => !reduced.has(k)).reduce((n, k) => n + price[k]!, 0) + keys.reduce((n, k) => n + fee(k), 0), 2000) });
    const all = Object.keys(price);
    for (const step of [["quiche"], ["quiche", "scone"], ["quiche", "scone", "flatOat"], ["quiche", "scone", "flatOat", "juice"]]) {
      const s = await byItem(EU, o, step);
      const own = [ownOf(all.filter((k) => !step.includes(k))), ownOf(step)];
      expect(s.checks.map((b) => rate(b, "10%")).reduce((a, b) => a + b, 0)).toBe(214);
      expect(s.checks.map((b) => rate(b, "20%")).reduce((a, b) => a + b, 0)).toBe(382);
      expectNotes(s.checks, own, step.join("+"));
      if (step.length === 1) expect(s.checks.map((b) => b.tax_note)).toEqual([null, null]);
      // Every line's taxable per rate is still its amount at that rate less its tax there, whatever cents moved (review).
      const rows = await db.sql<{ product_id: string; fee_amount: number; taxes: { bps: number; amount: number; taxable: number }[] }[]>`select product_id, fee_amount, taxes from order_lines where order_id = ${o.id}`;
      for (const l of rows) {
        const key = Object.entries(EU.products).find(([, id]) => id === l.product_id)![0];
        for (const t of l.taxes) {
          const gross = (t.bps === 1000 ? (reduced.has(key) ? price[key]! : 0) : reduced.has(key) ? 0 : price[key]!) + (t.bps === 2000 ? l.fee_amount : 0);
          expect(t.taxable, `${step.join("+")} ${key} ${t.bps}`).toBe(gross - t.amount);
        }
      }
      if (step.length === 4) {
        expect(s.checks.map((b) => [rate(b, "10%"), rate(b, "20%")])).toEqual([[77, 207], [137, 175]]);
        expect(s.checks.map((b) => b.tax_note !== null)).toEqual([false, true]);
      }
    }
    await cancel(EU, o.id);
  });
});

describe("V2: an even split keeps every line's shares within a cent as well as the bills", () => {
  const splitEven = async (w: World, orderId: string, n: number) => {
    const r = await call<Mut>("POST", `/v1/orders/${orderId}/checks/split-even`, { token: w.m.manager.token, body: { n } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data as unknown as Omit<Snap, "checks"> & { checks: Bill[] };
  };
  type Alloc = { check_id: string; order_line_id: string; base: number; taxes: Tax[] };
  async function expectEvenShares(orderId: string, label: string) {
    const allocs = await db.sql<Alloc[]>`select a.check_id, a.order_line_id, a.base, a.taxes from check_allocations a join checks c on c.id = a.check_id where c.order_id = ${orderId}`;
    for (const id of new Set(allocs.map((a) => a.order_line_id))) {
      const bases = allocs.filter((a) => a.order_line_id === id).map((a) => a.base);
      expect(Math.max(...bases) - Math.min(...bases), `${label}: ${bases.join(" / ")}`).toBeLessThanOrEqual(1);
    }
  }

  it("B's table 6: cheeseburger with bacon, onion rings and a soda ($25.47) three ways is $8.49 each, the burger $5.16 / $5.16 / $5.17", async () => {
    const o = await open(US, 1);
    const s = await add(US, o.body.data.id, ["cheeseBacon", "rings", "soda"], 1);
    expect(s.body.data.totals.total).toBe(2547);
    const split = await splitEven(US, o.body.data.id, 3);
    expect(split.checks.map((b) => b.totals.total)).toEqual([849, 849, 849]);
    await expectEvenShares(o.body.data.id, "B table 6");
    expect(split.checks.map((b) => b.totals.subtotal).sort()).toEqual([782, 782, 783]);
    // A bill with the larger subtotal never pays less tax than one with the smaller.
    const tax = (b: Bill) => b.totals.taxes.reduce((n, t) => n + t.amount, 0);
    for (const a of split.checks) for (const b of split.checks) if (a.totals.subtotal > b.totals.subtotal) expect(tax(a)).toBeGreaterThanOrEqual(tax(b) - 1);
    expect(split.checks.map((b) => rate(b, "State")).reduce((a, b) => a + b, 0)).toBe(94);
    expect(split.checks.map((b) => rate(b, "Local")).reduce((a, b) => a + b, 0)).toBe(106);
    const own = split.checks.map((b) => ({ State: Math.floor((b.totals.subtotal * 400 + 5000) / 10000), Local: Math.floor((b.totals.subtotal * 450 + 5000) / 10000) }));
    expectNotes(split.checks, own, "B table 6");
    for (const n of [2, 4, 5, 6]) {
      const again = await splitEven(US, o.body.data.id, n);
      const totals = again.checks.map((b) => b.totals.total);
      expect(Math.max(...totals) - Math.min(...totals), `${n} ways: ${totals.join(" / ")}`).toBeLessThanOrEqual(1);
      await expectEvenShares(o.body.data.id, `${n} ways`);
    }
    await cancel(US, o.body.data.id);
  });

  it("with the service fee, the same basket even 2–6 keeps bills and shares within a cent", async () => {
    const o = await feeOrder(US, ["cheeseBacon", "rings", "soda", "water"]);
    for (const n of [2, 3, 4, 5, 6]) {
      const again = await splitEven(US, o.id, n);
      const totals = again.checks.map((b) => b.totals.total);
      expect(Math.max(...totals) - Math.min(...totals), `${n} ways: ${totals.join(" / ")}`).toBeLessThanOrEqual(1);
      expect(totals.reduce((a, b) => a + b, 0)).toBe(o.totals.total);
      await expectEvenShares(o.id, `fee ${n} ways`);
    }
    await cancel(US, o.id);
  });
});

const pay = (w: World, checkId: string, amount: number, tender: "cash" | "card", i = 0, tip = 0) => call<Mut>("POST", `/v1/checks/${checkId}/payments`, { token: pos(w, i), body: { payment_id: randomUUID(), tender_type_id: tender === "cash" ? w.cash : w.card, amount, ...(tip ? { tip_cents: tip } : {}) } });
const boRefund = (w: World, checkId: string, request: unknown, extra: Record<string, unknown> = {}) => call<RefundRes>("POST", `/v1/checks/${checkId}/refunds`, { token: w.m.manager.token, body: { refund_id: randomUUID(), request, reason: "Wrong item keyed", print: false, ...extra } });
const pdfWords = async (path: string, token: string) => {
  const r = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
  expect(r.status, path).toBe(200);
  return pdfStrings(new Uint8Array(await r.arrayBuffer()));
};
/** A takeaway order at station `i`, sent and paid by card (with a tip) in one tender. */
async function paidByCard(w: World, keys: string[], tip = 0, i = 1) {
  const o = await open(w, i);
  const s = await add(w, o.body.data.id, keys, i);
  expect((await call("POST", `/v1/orders/${o.body.data.id}/fire`, { token: pos(w, i), body: {} })).status).toBe(200);
  const check = s.body.data.checks[0]!;
  const paid = await pay(w, check.id, check.balance, "card", i, tip);
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  return paid.body.data;
}
type RefundRow = { id: string; credit_note_no: string | null; totals: { total: number } };
const refundsOf = async (w: World, orderId: string) => (await db.sql<RefundRow[]>`select id, credit_note_no, jsonb_build_object('total', total) as totals from refunds where order_id = ${orderId} order by created_at`);

describe("V3: an invoice issued after a refund comes with a credit note for it", () => {
  for (const which of ["US", "EU"] as const) {
    it(`${which}: refund by items, then Get invoice: the refund gets the next credit note, the invoice lists it; a later refund gets its own at once; a tip refund none`, async () => {
      const w = which === "US" ? US : EU;
      const fmt = (c: number) => new Intl.NumberFormat(which === "US" ? "en-US" : "de-DE", { style: "currency", currency: which === "US" ? "USD" : "EUR" }).format(c / 100);
      // The café has tips turned off.
      const o = await paidByCard(w, which === "US" ? ["coffee", "tea", "rings"] : ["cake", "juice", "wine"], which === "US" ? 200 : 0);
      const check = o.checks[0]!;
      const first = await boRefund(w, check.id, { kind: "lines", lines: [{ line_id: o.lines[0]!.id, quantity: 1 }, { line_id: o.lines[1]!.id, quantity: 1 }] });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body.refund.credit_note_no).toBeNull();
      const cnBefore = (await db.sql<{ n: number }[]>`select coalesce(max(next_no), 1)::int as n from document_sequences where merchant_id = ${w.m.merchantId} and kind = 'credit_note'`)[0]!.n;

      const inv = await call<{ data: { invoice_no: string } }>("POST", `/v1/checks/${check.id}/invoice`, { token: w.m.manager.token, body: {} });
      expect(inv.status, JSON.stringify(inv.body)).toBe(200);
      const [r1] = await refundsOf(w, o.id);
      expect(r1!.credit_note_no).toBe(`CN-${String(cnBefore).padStart(6, "0")}`);
      // The invoice: the sale as paid, then its credit note.
      const words = await pdfWords(`/v1/checks/${check.id}/invoice.pdf`, w.m.manager.token);
      const at = words.indexOf(`Credit note ${r1!.credit_note_no}`);
      expect(at, words.join(" | ")).toBeGreaterThan(-1);
      expect(words[at + 1]).toBe(`−${fmt(first.body.refund.totals.total)}`);
      // The credit note: against the invoice, the refund's lines and tax, signed.
      const cn = await pdfWords(`/v1/refunds/${r1!.id}/credit-note.pdf`, w.m.manager.token);
      expect(cn).toContain("CREDIT NOTE");
      expect(cn).toContain(`Against invoice ${inv.body.data.invoice_no}`);
      expect(cn).toContain(`−${fmt(first.body.refund.totals.total)}`);
      // Asking again reuses the invoice and issues nothing more.
      const again = await call<{ data: { invoice_no: string; reused: boolean } }>("POST", `/v1/checks/${check.id}/invoice`, { token: w.m.manager.token, body: {} });
      expect(again.body.data).toMatchObject({ invoice_no: inv.body.data.invoice_no, reused: true });
      // The reverse order still works: a refund after the invoice gets a credit note at once.
      const later = await boRefund(w, check.id, { kind: "lines", lines: [{ line_id: o.lines[2]!.id, quantity: 1 }] });
      expect(later.status, JSON.stringify(later.body)).toBe(201);
      expect(later.body.refund.credit_note_no).toBe(`CN-${String(cnBefore + 1).padStart(6, "0")}`);
      // Now only the tip is left: its refund gets no credit note.
      if (which === "US") {
        const tip = await boRefund(w, check.id, { kind: "full" });
        expect(tip.status, JSON.stringify(tip.body)).toBe(201);
        expect(tip.body.refund.totals.total).toBe(0);
        expect(tip.body.refund.credit_note_no).toBeNull();
      }
      // Refund rows stay immutable otherwise.
      await expect(db.sql`update refunds set total = total + 1 where id = ${r1!.id}`).rejects.toThrow(/append_only/);
      await expect(db.sql`update refunds set credit_note_no = 'CN-999999' where id = ${r1!.id}`).rejects.toThrow(/append_only/);
    });
  }

  it("a tip-only refund made before the invoice gets no credit note when the invoice is issued", async () => {
    const o = await paidByCard(US, ["coffee"], 100);
    const check = o.checks[0]!;
    // Every item back, then the tip on its own.
    expect((await boRefund(US, check.id, { kind: "lines", lines: [{ line_id: o.lines[0]!.id, quantity: 1 }] })).status).toBe(201);
    expect((await boRefund(US, check.id, { kind: "full" })).status).toBe(201);
    expect((await call("POST", `/v1/checks/${check.id}/invoice`, { token: US.m.manager.token, body: {} })).status).toBe(200);
    const rows = await refundsOf(US, o.id);
    expect(rows.map((r) => r.credit_note_no !== null)).toEqual([true, false]);
  });
});

describe("V4: a credit note for a bill paid with two tenders closes with what was refunded", () => {
  const eur = (c: number) => new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(c / 100);
  it("the reopen's credit note reads Cash −, Card −, Refunded − (never a positive Paid); a two-tender refund's too", async () => {
    const o = await open(EU, 1);
    const s = await add(EU, o.body.data.id, ["sandwich", "wine", "tea"], 1);
    expect((await call("POST", `/v1/orders/${o.body.data.id}/fire`, { token: pos(EU, 1), body: {} })).status).toBe(200);
    const check = s.body.data.checks[0]!;
    const shift = await call<{ data: { id: string } }>("POST", "/v1/shifts", { token: pos(EU, 1), body: { float_cents: 5000 } });
    expect(shift.status, JSON.stringify(shift.body)).toBe(201);
    expect((await pay(EU, check.id, 1000, "cash", 1)).status).toBe(200);
    expect((await pay(EU, check.id, check.balance - 1000, "card", 1)).status).toBe(200);
    expect((await call("POST", `/v1/checks/${check.id}/invoice`, { token: EU.m.manager.token, body: {} })).status).toBe(200);
    const invoice = await pdfWords(`/v1/checks/${check.id}/invoice.pdf`, EU.m.manager.token);
    expect(invoice[invoice.indexOf("Paid") + 1]).toBe(eur(1900));
    const reopen = await call<Mut>("POST", `/v1/orders/${o.body.data.id}/reopen`, { token: EU.m.manager.token, body: { reason: "Wrong items" } });
    expect(reopen.status, JSON.stringify(reopen.body)).toBe(200);
    const [x] = await db.sql<{ id: string }[]>`select id from invoice_cancellations where check_id = ${check.id}`;
    const cn = await pdfWords(`/v1/invoice-cancellations/${x!.id}/credit-note.pdf`, EU.m.manager.token);
    expect(cn).not.toContain("Paid");
    expect(cn[cn.indexOf("Refunded") + 1]).toBe(`−${eur(1900)}`);
    expect(cn[cn.indexOf("Cash") + 1]).toBe(`−${eur(1000)}`);

    // Paid again in two tenders, invoiced, then refunded in full to both: the same closing row.
    const again = (await call<{ data: Snap }>("GET", `/v1/orders/${o.body.data.id}`, { token: EU.m.manager.token })).body.data.checks[0]!;
    expect((await pay(EU, again.id, 1000, "cash", 1)).status).toBe(200);
    expect((await pay(EU, again.id, again.balance - 1000, "card", 1)).status).toBe(200);
    expect((await call("POST", `/v1/checks/${again.id}/invoice`, { token: EU.m.manager.token, body: {} })).status).toBe(200);
    const full = await call<RefundRes>("POST", `/v1/checks/${again.id}/refunds`, { token: pos(EU, 1), body: { refund_id: randomUUID(), request: { kind: "full" }, reason: "Complaint", print: false } });
    expect(full.status, JSON.stringify(full.body)).toBe(201);
    const words = await pdfWords(`/v1/refunds/${full.body.refund.id}/credit-note.pdf`, EU.m.manager.token);
    expect(words).not.toContain("Paid");
    expect(words[words.indexOf("Refunded") + 1]).toBe(`−${eur(1900)}`);
    // The refund receipt says the same (the thermal and digital receipts read this document).
    const [rr] = await db.sql<{ receipt_document: { paid_total?: number } }[]>`select receipt_document from refunds where id = ${full.body.refund.id}`;
    expect(rr!.receipt_document.paid_total).toBe(-1900);
  });
});

describe("V6: a station's Z-report is blind only while a drawer in its scope is open", () => {
  type ZRes = { data: { withheld?: string; cash: { float: number; expected?: number; variance?: number | null; open_shifts: { count: number; float: number } }; sales?: { net: number } } };
  const z = (w: World, token: string, stationId?: string) => call<ZRes["data"] extends infer D ? { data: D } : never>("GET", `/v1/outlets/${w.m.outletId}/z-report${stationId ? `?station_id=${stationId}` : ""}`, { token });
  it("Station 1's Cashier closes their shift while Station 2's drawer stays open: Station 1's report shows its figures; the whole outlet and Station 2 stay blind and name only their own drawers", async () => {
    const w = US;
    const cashier = pos(w, 0);
    const s1 = await call<{ data: { id: string } }>("POST", "/v1/shifts", { token: cashier, body: { float_cents: 8_000 } });
    expect(s1.status, JSON.stringify(s1.body)).toBe(201);
    const s2 = await call<{ data: { id: string } }>("POST", "/v1/shifts", { token: pos(w, 1), body: { float_cents: 10_000 } });
    expect(s2.status, JSON.stringify(s2.body)).toBe(201);
    for (const i of [0, 1]) {
      const o = await open(w, i);
      const s = await add(w, o.body.data.id, ["coffee"], i);
      expect((await call("POST", `/v1/orders/${o.body.data.id}/fire`, { token: pos(w, i), body: {} })).status).toBe(200);
      expect((await pay(w, s.body.data.checks[0]!.id, s.body.data.checks[0]!.balance, "cash", i)).status).toBe(200);
    }
    // Before the close: Station 1's own drawer is open, so its report is blind and names only that drawer.
    const before = await z(w, cashier, w.stations[0]!.id);
    expect(before.body.data.withheld).toBe("open_shift");
    expect(before.body.data.cash.open_shifts).toEqual({ count: 1, float: 8_000 });

    const coffee = 279 + 24; // $2.79 + 4% + 4.5%
    const closed = await call("POST", `/v1/shifts/${s1.body.data.id}/close`, { token: cashier, body: { counted_cash_cents: 8_000 + coffee } });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    const mine = await z(w, cashier, w.stations[0]!.id);
    expect(mine.body.data.withheld).toBeUndefined();
    expect(mine.body.data.cash).toMatchObject({ float: 8_000, expected: 8_000 + coffee, variance: 0 });
    const outlet = await z(w, cashier);
    expect(outlet.body.data.withheld).toBe("open_shift");
    expect(outlet.body.data.cash.open_shifts).toEqual({ count: 1, float: 10_000 });
    const other = await z(w, cashier, w.stations[1]!.id);
    expect(other.body.data.withheld).toBe("open_shift");
    expect(other.body.data.cash.open_shifts).toEqual({ count: 1, float: 10_000 });
    // Nothing the Cashier is shown lets them work out Station 2's expected cash.
    for (const r of [outlet, other]) expect(JSON.stringify(r.body.data)).not.toContain(String(10_000 + coffee));
    // A Manager sees every scope.
    expect((await z(w, w.m.manager.token)).body.data.withheld).toBeUndefined();
    const close2 = await call("POST", `/v1/shifts/${s2.body.data.id}/close`, { token: pos(w, 1), body: { counted_cash_cents: 10_000 + coffee } });
    expect(close2.status, JSON.stringify(close2.body)).toBe(200);
    expect((await z(w, cashier)).body.data.withheld).toBeUndefined();
  });
});

describe("V8: a percentage tip is on the items, before fees and tax, with or without a service fee", () => {
  it("15% on a salad with the 10% service fee is 15% of $8.99, not of $9.89; a half payment tips half", async () => {
    const o = await feeOrder(US, ["salad"]);
    const check = o.checks[0]!;
    expect(check.totals.total).toBe(899 + 90 + 40 + 45);
    type P = { payment: { tip_cents: number } };
    const full = await call<P>("POST", `/v1/checks/${check.id}/payments`, { token: US.m.manager.token, body: { payment_id: randomUUID(), tender_type_id: US.card, amount: check.balance, tip_bps: 1500, dry_run: true } });
    expect(full.status, JSON.stringify(full.body)).toBe(200);
    expect(full.body.payment.tip_cents).toBe(135);
    const half = await call<P>("POST", `/v1/checks/${check.id}/payments`, { token: US.m.manager.token, body: { payment_id: randomUUID(), tender_type_id: US.card, amount: 537, tip_bps: 1500, dry_run: true } });
    expect(half.body.payment.tip_cents).toBe(Math.round(Math.round((537 * 899) / 1074) * 0.15));
    await cancel(US, o.id);
  });
});

describe("V8: words on documents and in the back office", () => {
  it("a fee applied by hand is audited as a fee; a rule version names who saved it", async () => {
    const o = await feeOrder(US, ["soda", "rings"]);
    const [row] = await db.sql<{ details: { rule_kind?: string } }[]>`select details from audit_log where action = 'adjustments.apply_manual' and target_id = ${o.id}`;
    expect(row!.details.rule_kind).toBe("fee");
    const versions = (await call<{ data: { created_by_name: string | null }[] }>("GET", "/v1/pricing-rules?rule_key=svc10", { token: US.m.admin.token })).body.data;
    expect(versions[0]!.created_by_name).toBeTruthy();
    expect(versions[0]!.created_by_name).not.toMatch(/^[0-9a-f]{8}-/);
    await cancel(US, o.id);
  });

  it("a credit note's share row uses the same true minus as its amounts: Share of −2 × soda", async () => {
    const o = await open(US, 1);
    const s = await call<Mut>("POST", `/v1/orders/${o.body.data.id}/lines`, { token: pos(US, 1), body: { lines: [{ line_id: randomUUID(), product_id: US.products.soda, quantity: 2 }] } });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect((await call("POST", `/v1/orders/${o.body.data.id}/fire`, { token: pos(US, 1), body: {} })).status).toBe(200);
    const split = await call<{ data: Snap }>("POST", `/v1/orders/${o.body.data.id}/checks/split-even`, { token: US.m.manager.token, body: { n: 2 } });
    expect(split.status, JSON.stringify(split.body)).toBe(200);
    for (const c of split.body.data.checks) expect((await pay(US, c.id, c.balance, "card", 1)).status).toBe(200);
    const bill1 = split.body.data.checks[0]!.id;
    expect((await call("POST", `/v1/checks/${bill1}/invoice`, { token: US.m.manager.token, body: {} })).status).toBe(200);
    expect((await call("POST", `/v1/orders/${o.body.data.id}/reopen`, { token: US.m.manager.token, body: { reason: "Wrong items" } })).status).toBe(200);
    const [x] = await db.sql<{ id: string }[]>`select id from invoice_cancellations where check_id = ${bill1}`;
    const words = await pdfWords(`/v1/invoice-cancellations/${x!.id}/credit-note.pdf`, US.m.manager.token);
    expect(words.some((w) => w.startsWith("Share of −2 × soda")), words.join(" | ")).toBe(true);
    expect(words.some((w) => w.includes("-2"))).toBe(false);
  });
});
