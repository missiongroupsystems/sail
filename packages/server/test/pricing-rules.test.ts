import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEED_RULE_IDS, type PricingResult } from "@sail/shared";
import { ALL_CASES } from "@sail/shared/reference";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { withTransaction } from "../src/db/client.js";
import { activateDueRules, seedRulesForMerchant } from "../src/services/pricing-rules.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

let db: TestDb;
let app: App;
let A: SeededMerchant;
let call: ReturnType<typeof api>["call"];

beforeAll(async () => {
  db = await freshDb();
  app = buildApp();
  call = api(app).call;
  A = await seedMerchant(db.sql, "Alpha");
  await withTransaction(() => seedRulesForMerchant(A.merchantId));
});
afterAll(async () => {
  await db.drop();
});

describe("persisted pricing rules", () => {
  it("seeds the eight default rules as active version 1", async () => {
    const r = await call<{ data: { rule_key: string; version: number; status: string }[] }>("GET", "/v1/pricing-rules", { token: A.manager.token });
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(8);
    expect(r.body.data.every((v) => v.version === 1 && v.status === "active")).toBe(true);
    expect(r.body.data.map((v) => v.rule_key)).toContain(SEED_RULE_IDS.serviceCharge);
  });

  it("the simulator on persisted rules reproduces every seed-rule reference case", async () => {
    // Every reference case whose rules are exactly the seed set can be replayed through the simulator.
    const seedCases = ALL_CASES.filter((c) => c.rules.length === 8 && c.rules.every((r) => r.id.startsWith("seed:")) && !c.context.frozen);
    expect(seedCases.length).toBeGreaterThan(5);
    for (const c of seedCases) {
      const r = await call<{ data: PricingResult }>("POST", "/v1/pricing/simulate", {
        token: A.manager.token,
        body: { outlet_id: A.outletId, brand_id: A.brandId, order_type: c.order.order_type, channel: c.order.channel, customer_group_ids: c.order.customer_group_ids ?? [], lines: c.order.lines, manual_applications: c.order.manual_applications ?? [], at: c.context.now, tax_mode: c.context.tax_mode },
      });
      expect(r.status, `${c.id} status`).toBe(200);
      expect(r.body.data.totals.total, `${c.id} total`).toBe(c.expect.total);
      if (c.expect.gst_total != null) expect(r.body.data.totals.gst_total, `${c.id} gst`).toBe(c.expect.gst_total);
    }
  });

  it("only Admin can create versions; a server cannot even simulate", async () => {
    expect((await call("POST", "/v1/pricing-rules", { token: A.manager.token, body: { rule_key: "x", body: {} } })).status).toBe(403);
    expect((await call("POST", "/v1/pricing/simulate", { token: A.server.token, body: { outlet_id: A.outletId, brand_id: A.brandId, order_type: "dine_in", lines: [] } })).status).toBe(403);
  });

  it("a scheduled version takes effect at its time; earlier evaluations keep the old version", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const body = { kind: "fee", name: "Service charge 12%", calc: "percent", value: { type: "fixed", amount: 1200 }, scope: { type: "all" }, conditions: { order_types: ["dine_in"] }, priority: 100, application: "auto", gst_applicable: true, report_class: "service_charge" };
    const created = await call<{ data: { version: number; status: string }; warnings: string[] }>("POST", "/v1/pricing-rules", { token: A.admin.token, body: { rule_key: SEED_RULE_IDS.serviceCharge, body, effective_from: future.toISOString(), note: "rate change" } });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ version: 2, status: "scheduled" });

    const line = { product_id: randomUUID(), quantity: 1 };
    await call("POST", "/v1/products", { token: A.admin.token, body: { id: line.product_id, name: "Plate", price: 10_000 } });
    const now = await call<{ data: PricingResult }>("POST", "/v1/pricing/simulate", { token: A.manager.token, body: { outlet_id: A.outletId, brand_id: A.brandId, order_type: "dine_in", lines: [line] } });
    expect(now.body.data.totals.fee_total).toBe(1000);
    const later = await call<{ data: PricingResult }>("POST", "/v1/pricing/simulate", { token: A.manager.token, body: { outlet_id: A.outletId, brand_id: A.brandId, order_type: "dine_in", lines: [line], at: new Date(future.getTime() + 1000).toISOString() } });
    expect(later.body.data.totals.fee_total).toBe(1200);
    expect(later.body.data.adjustments[0]!.rule_version).toBe(2);

    // The worker flips statuses once the time has passed.
    const activated = await withTransaction(() => activateDueRules(new Date(future.getTime() + 1000)));
    expect(activated.map((a) => a.version)).toEqual([2]);
    const versions = await call<{ data: { version: number; status: string }[] }>("GET", `/v1/pricing-rules?rule_key=${SEED_RULE_IDS.serviceCharge}`, { token: A.manager.token });
    expect(versions.body.data.map((v) => [v.version, v.status])).toEqual([
      [2, "active"],
      [1, "superseded"],
    ]);
  });

  it("versions are immutable in the database", async () => {
    await expect(db.sql`update pricing_rules set body = '{}'::jsonb where merchant_id = ${A.merchantId} and version = 1 and rule_key = ${SEED_RULE_IDS.serviceCharge}`).rejects.toThrow(/immutable/);
  });

  it("an invalid rule body is a validation error", async () => {
    const r = await call<{ code: string; message: string }>("POST", "/v1/pricing-rules", { token: A.admin.token, body: { rule_key: "bad", body: { kind: "discount", name: "Bad", calc: "fixed_per_order", level: "line", value: { type: "fixed", amount: 100 }, scope: { type: "all" }, priority: 1, application: "auto", report_class: "promo" } } });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/order-level/);
  });

  it("validation warnings fire for seeded misconfigurations and archive stops a rule", async () => {
    const overlap = { kind: "discount", name: "Half off everything", calc: "percent", value: { type: "fixed", amount: 5000 }, scope: { type: "all" }, stacking: "exclusive", priority: 5, application: "auto", report_class: "promo" };
    const overlap2 = { ...overlap, name: "Another exclusive", priority: 6 };
    const capped = { kind: "discount", name: "Cap too low", calc: "fixed_per_order", value: { type: "fixed", amount: 1000 }, cap: 500, scope: { type: "all" }, priority: 7, application: "auto", report_class: "promo" };
    const v = await call<{ data: { warnings: { code: string; severity: string }[] } }>("POST", "/v1/pricing-rules/validate", { token: A.manager.token, body: { rules: [{ id: "a", ...overlap }, { id: "b", ...overlap2 }, { id: "c", ...capped }] } });
    expect(v.status).toBe(200);
    expect(v.body.data.warnings.map((w) => w.code).sort()).toEqual(["cap_below_minimum", "overlapping_exclusive"]);
    expect(v.body.data.warnings.find((w) => w.code === "cap_below_minimum")!.severity).toBe("blocking");

    // Products no fee covers: archive the service charge and the deposit → every product uncovered.
    const archived = await call<{ data: { versions_archived: number } }>("POST", `/v1/pricing-rules/${SEED_RULE_IDS.serviceCharge}/archive`, { token: A.admin.token, body: { reason: "test" } });
    expect(archived.body.data.versions_archived).toBe(2);
    await call("POST", `/v1/pricing-rules/${SEED_RULE_IDS.containerDeposit}/archive`, { token: A.admin.token, body: {} });
    const v2 = await call<{ data: { warnings: { code: string }[] } }>("POST", "/v1/pricing-rules/validate", { token: A.manager.token, body: {} });
    expect(v2.body.data.warnings.map((w) => w.code)).toEqual(["disables_nothing"]); // the waiver now switches off nothing; no fees → no uncovered-product warning
    const sim = await call<{ data: PricingResult }>("POST", "/v1/pricing/simulate", { token: A.manager.token, body: { outlet_id: A.outletId, brand_id: A.brandId, order_type: "dine_in", lines: [{ product_id: (await db.sql`select id from products where name = 'Plate'`)[0]!.id, quantity: 1 }] } });
    expect(sim.body.data.totals.fee_total).toBe(0);
  });
});
