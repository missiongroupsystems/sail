import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDb } from "./helpers.js";
import { bootWorld, orderHelpers, type Call, type World } from "./world.js";
import { rowRefusal, runQueuedImports } from "../src/services/importer.js";
import { activateDueRules } from "../src/services/pricing-rules.js";
import { withTransaction } from "../src/db/client.js";

/**
 * What the back office can save, and what staff are told when something is refused. Each rule here is one a tester
 * broke on the live demo: a record the API took but the register or the back office could not use, or a refusal
 * that spoke in operation names, validator text or minor units.
 */
let db: TestDb;
let call: Call;
let w: World;
type Err = { code: string; message: string; remedy?: string; details?: Record<string, unknown> };

beforeAll(async () => {
  ({ db, call, w } = await bootWorld());
});
afterAll(async () => db.drop());

const admin = (method: string, path: string, body?: unknown) => call<Err & { data: { id: string } }>(method, path, { token: w.m.admin.token, body });

describe("report categories are two levels deep and named", () => {
  it("refuses a blank name, a category under itself, a third level and a cycle", async () => {
    expect((await admin("POST", "/v1/categories", { name: "   " })).status).toBe(400);
    const food = (await admin("POST", "/v1/categories", { name: "Food" })).body.data.id;
    const noodles = (await admin("POST", "/v1/categories", { name: "Noodles", parent_id: food })).body.data.id;
    expect((await admin("PATCH", `/v1/categories/${food}`, { parent_id: food })).status).toBe(400);
    const third = await admin("POST", "/v1/categories", { name: "Ramen", parent_id: noodles });
    expect(third.status).toBe(400);
    expect(third.body.message).toBe("A category can only sit under a top-level category");
    // Food under Noodles would close a loop (and make a third level).
    expect((await admin("PATCH", `/v1/categories/${food}`, { parent_id: noodles })).status).toBe(400);
    const drinks = (await admin("POST", "/v1/categories", { name: "Drinks" })).body.data.id;
    expect((await admin("PATCH", `/v1/categories/${noodles}`, { parent_id: drinks })).status).toBe(200);
    // A third level saved before this rule can still be renamed, even by a form that sends its parent back unchanged.
    const legacy = randomUUID();
    await db.sql.begin(async (t) => {
      await t`alter table report_categories disable trigger report_categories_nesting`;
      await t`insert into report_categories (id, merchant_id, name, parent_id) values (${legacy}, ${w.m.merchantId}, 'Old third level', ${noodles})`;
      await t`alter table report_categories enable trigger report_categories_nesting`;
    });
    expect((await admin("PATCH", `/v1/categories/${legacy}`, { name: "Renamed", parent_id: noodles })).status).toBe(200);
  });

  it("an import rejects a third-level row on its own and keeps the rows around it", async () => {
    const files = { "categories.csv": "id,name,parent\nTOP,Top,\nMID,Mid,TOP\nLOW,Low,MID\nAFTER,After,\n" };
    const mapping = { files: [{ name: "categories.csv", entity: "categories", columns: { legacy_id: "id", name: "name", parent_legacy_id: "parent" } }] };
    const job = await admin("POST", "/v1/imports", { files, mapping, dry_run: false });
    expect(job.status, JSON.stringify(job.body)).toBe(201);
    await runQueuedImports();
    const report = (await call<{ data: { status: string; report: { entities: { categories: { creates: number; rejected: { row: number; reason: string }[] } } } } }>("GET", `/v1/imports/${job.body.data.id}`, { token: w.m.admin.token })).body.data;
    expect(report.status).toBe("applied");
    expect(report.report.entities.categories.rejected.map((r) => [r.row, r.reason])).toEqual([[4, "A category can only sit under a top-level category"]]);
    const names = (await db.sql<{ name: string }[]>`select name from report_categories where merchant_id = ${w.m.merchantId} and legacy_id in ('TOP', 'MID', 'LOW', 'AFTER') order by name`).map((r) => r.name);
    expect(names).toEqual(["After", "Mid", "Top"]);
  });
});

describe("numbers the database stores in 32 bits are bounded at the API", () => {
  it("a huge daily cap, table size or sort order is a validation error, not a 500", async () => {
    const cap = await call<Err>("POST", "/v1/stock/daily-cap", { token: w.m.manager.token, body: { outlet_id: w.m.outletId, product_id: w.ids.kopi, quantity: 2_147_483_648 } });
    expect(cap.status).toBe(400);
    expect(cap.body.message).toBe("Quantity can be at most 100000");
    const area = (await admin("POST", "/v1/areas", { outlet_id: w.m.outletId, name: "Hall" })).body.data.id;
    const table = await admin("POST", "/v1/tables", { outlet_id: w.m.outletId, area_id: area, name: "T", seats: 100_000 });
    expect(table.status).toBe(400);
    expect(table.body.message).toBe("Seats can be at most 99");
    expect((await admin("POST", "/v1/void-reasons", { name: "Spilt", sort: 2 ** 31 })).status).toBe(400);
    const order = await orderHelpers(call, w).orderWith(w.pins.cashier, [{ product_id: w.ids.kopi }]);
    expect((await call("PATCH", `/v1/orders/${order.id}`, { token: w.pins.cashier, body: { expected_version: 2 ** 31, takeaway_ref: "x" } })).status).toBe(400);
  });
});

describe("tax rates", () => {
  it("a negative rate is refused, not saved as a positive one", async () => {
    const cls = (await call<{ data: { id: string; rates: { outlet_id: string | null; order_type: string | null; components: { name: string; bps: number }[] }[] }[] }>("GET", "/v1/tax-classes", { token: w.m.admin.token })).body.data[0]!;
    const before = cls.rates.find((r) => r.outlet_id == null && r.order_type == null)!.components;
    const r = await call<Err>("PUT", `/v1/tax-classes/${cls.id}/rates`, { token: w.m.admin.token, body: { outlet_id: null, order_type: null, components: [{ name: "VAT", bps: -500 }] } });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/at least 0/);
    const after = (await call<{ data: { id: string; rates: { outlet_id: string | null; order_type: string | null; components: unknown }[] }[] }>("GET", "/v1/tax-classes", { token: w.m.admin.token })).body.data.find((k) => k.id === cls.id)!;
    expect(after.rates.find((x) => x.outlet_id == null && x.order_type == null)!.components).toEqual(before);
  });
});

describe("a modifier group must be possible to satisfy", () => {
  it("refuses a minimum choice with no options, or more than the options allow", async () => {
    expect((await admin("POST", "/v1/modifier-groups", { name: "Sauce", min_select: 1 })).status).toBe(400);
    const two = [{ product_id: w.ids.kopi }, { product_id: w.ids.laksa }];
    expect((await admin("POST", "/v1/modifier-groups", { name: "Sides", min_select: 3, options: two })).body.message).toBe("The group asks for 3 choices but its options allow only 2");
    const ok = await admin("POST", "/v1/modifier-groups", { name: "Sides", min_select: 2, options: two });
    expect(ok.status).toBe(201);
    // Taking an option away later is checked the same way.
    expect((await admin("PATCH", `/v1/modifier-groups/${ok.body.data.id}`, { options: [two[0]] })).status).toBe(400);
    expect((await admin("PATCH", `/v1/modifier-groups/${ok.body.data.id}`, { options: [two[0]], max_per_modifier: 2 })).status).toBe(200);
  });
});

describe("staff and passwords", () => {
  it("an email address belongs to one person whatever its case", async () => {
    expect((await admin("POST", "/v1/staff", { name: "Kai", role: "server", email: "kai@example.test" })).status).toBe(201);
    const twin = await admin("POST", "/v1/staff", { name: "Kai Two", role: "server", email: "Kai@Example.TEST" });
    expect(twin.status).toBe(409);
    expect(twin.body.details).toEqual({ field: "email" });
    // A row stored before addresses were lower-cased is caught too.
    await db.sql`update staff set email = 'Old.Case@example.test' where email = 'kai@example.test'`;
    expect((await admin("POST", "/v1/staff", { name: "Kai Three", role: "server", email: "old.case@example.test" })).status).toBe(409);
  });

  it("an import rejects a staff row whose email someone already has, in any case, and keeps the others", async () => {
    await admin("POST", "/v1/staff", { name: "Rae", role: "server", email: "rae@example.test" });
    // Stored before addresses were lower-cased, so the unique index alone would not catch the import's lower-case twin.
    await db.sql`update staff set email = 'Rae@Example.test' where email = 'rae@example.test' and merchant_id = ${w.m.merchantId}`;
    const files = { "staff.csv": "id,name,email,role\nS1,Rae Again,RAE@example.TEST,server\nS2,Noor,noor@example.test,server\n" };
    const mapping = { files: [{ name: "staff.csv", entity: "staff", columns: { legacy_id: "id", name: "name", email: "email", role: "role" } }] };
    const job = await admin("POST", "/v1/imports", { files, mapping, dry_run: false });
    expect(job.status, JSON.stringify(job.body)).toBe(201);
    await runQueuedImports();
    const report = (await call<{ data: { status: string; report: { entities: { staff: { creates: number; rejected: { row: number; reason: string }[] } } } } }>("GET", `/v1/imports/${job.body.data.id}`, { token: w.m.admin.token })).body.data;
    expect(report.status).toBe("applied");
    expect(report.report.entities.staff.rejected.map((r) => [r.row, r.reason])).toEqual([[2, "email rae@example.test is already used by another staff member"]]);
    expect(report.report.entities.staff.creates).toBe(1);
    const emails = (await db.sql<{ email: string }[]>`select email from staff where merchant_id = ${w.m.merchantId} and lower(email) in ('rae@example.test', 'noor@example.test') order by email`).map((r) => r.email);
    expect(emails).toEqual(["Rae@Example.test", "noor@example.test"]);
  });

  it("the staff form cannot be used to search for colleagues' PINs", async () => {
    const id = (await admin("POST", "/v1/staff", { name: "Sam", role: "server" })).body.data.id;
    // A PIN someone has is refused, so two people never share one; a free PIN is fine and does not count.
    const taken = await admin("PATCH", `/v1/staff/${id}`, { pin: "444444" });
    expect(taken.status).toBe(409);
    expect(taken.body.details).toEqual({ field: "pin" });
    for (let i = 0; i < 6; i++) expect((await admin("PATCH", `/v1/staff/${id}`, { pin: "583920" })).status).toBe(200);
    // A few more taken PINs, and then setting any PIN waits, free or taken, so the answers stop telling them apart.
    for (const pin of ["333333", "222222", "111111"]) expect((await admin("PATCH", `/v1/staff/${id}`, { pin })).status).toBe(409);
    expect((await admin("POST", "/v1/staff", { name: "Sam Two", role: "server", pin: "444444" })).status).toBe(409);
    for (const pin of ["333333", "690417"]) {
      const r = await admin("PATCH", `/v1/staff/${id}`, { pin });
      expect(r.status, pin).toBe(429);
      expect(r.body.message).toBe("Too many PINs that someone already uses");
    }
    // Edits that do not set a PIN are not held up.
    expect((await admin("PATCH", `/v1/staff/${id}`, { name: "Sam Lee" })).status).toBe(200);
  });

  it("an import, dry run or not, cannot be used to search for PINs either, and its refusals name no constraint", async () => {
    await db.sql`delete from pin_attempts where merchant_id = ${w.m.merchantId}`;
    const pins = ["444444", "333333", "222222", "111111", "582913", "444444", "690418"];
    const files = { "staff.csv": "id,name,role,pin\n" + pins.map((pin, i) => `P${i},Probe ${i},server,${pin}`).join("\n") + "\n" };
    const mapping = { files: [{ name: "staff.csv", entity: "staff", columns: { legacy_id: "id", name: "name", role: "role", pin: "pin" } }] };
    const job = await admin("POST", "/v1/imports", { files, mapping, dry_run: true });
    expect(job.status, JSON.stringify(job.body)).toBe(201);
    await runQueuedImports();
    const report = (await call<{ data: { status: string; report: { entities: { staff: { creates: number; rejected: { row: number; reason: string }[] } } } } }>("GET", `/v1/imports/${job.body.data.id}`, { token: w.m.admin.token })).body.data;
    expect(report.status).toBe("dry_run_complete");
    const taken = "Someone at this business already uses that PIN";
    const held = "Too many PINs that someone already uses";
    expect(report.report.entities.staff.rejected.map((r) => [r.row, r.reason])).toEqual([[2, taken], [3, taken], [4, taken], [5, taken], [7, held], [8, held]]);
    // The staff form shares the count.
    expect((await admin("POST", "/v1/staff", { name: "Late", role: "server", pin: "713305" })).status).toBe(429);
    await db.sql`delete from pin_attempts where merchant_id = ${w.m.merchantId}`;
  });

  it("an import row the database refuses is told in words, not by constraint", async () => {
    const refusal = async (q: () => Promise<unknown>) => {
      try {
        await db.sql.begin(async () => q());
      } catch (e) {
        return rowRefusal(e);
      }
      throw new Error("the statement was not refused");
    };
    const [held] = await db.sql<{ pin_lookup: string }[]>`select pin_lookup from staff where merchant_id = ${w.m.merchantId} and pin_lookup is not null limit 1`;
    const dupPin = await refusal(() => db.sql`insert into staff (id, merchant_id, name, initials, role, pin_lookup) values (${randomUUID()}, ${w.m.merchantId}, 'Twin', 'TW', 'server', ${held!.pin_lookup})`);
    expect(dupPin).toBe("Someone at this business already uses that PIN");
    const dangling = await refusal(() => db.sql`insert into report_categories (id, merchant_id, name, parent_id) values (${randomUUID()}, ${w.m.merchantId}, 'Orphan', ${randomUUID()})`);
    expect(dangling).toBe("A referenced record does not exist");
    for (const m of [dupPin, dangling]) expect(m).not.toMatch(/constraint|_uq|fkey|same_merchant|Key \(/);
    expect(rowRefusal(new Error("name is required"))).toBe("name is required");
  });

  it("a long but trivial password is refused when it is set", async () => {
    const id = (await admin("POST", "/v1/staff", { name: "Pat", role: "manager", email: "pat@example.test" })).body.data.id;
    const link = await admin("POST", `/v1/staff/${id}/invite`, {});
    const token = new URL((link.body.data as unknown as { url: string }).url).hash.replace(/^#token=/, "");
    const accept = (password: string) => call<Err>("POST", "/v1/auth/links/accept", { body: { token, password }, idempotencyKey: null });
    for (const weak of ["aaaaaaaaaaaa", "abcabcabcabc", "123456789012", "abcdefghijklmn", "qwertyuiopas", "zyxwvutsrqpo"]) {
      const r = await accept(weak);
      expect(r.status, weak).toBe(400);
      expect(r.body.message).toBe("That password is too easy to guess");
    }
    expect((await accept("plum harbour lantern")).status).toBe(201);
  });
});

describe("pricing rule versions and sold-out times cannot be set in the past", () => {
  const body = { name: "Happy hour", kind: "discount", calc: "percent", value: { type: "fixed", amount: 1000 }, scope: { type: "all" }, priority: 1, application: "auto", report_class: "promo" };
  it("a new version dated before the version it replaces is refused, so the list and the register agree", async () => {
    const now = Date.now();
    expect((await admin("POST", "/v1/pricing-rules", { rule_key: "hh", body, effective_from: new Date(now - 3_600_000).toISOString() })).status).toBe(201);
    const earlier = await admin("POST", "/v1/pricing-rules", { rule_key: "hh", body: { ...body, name: "Happy hour 2" }, effective_from: new Date(now - 7_200_000).toISOString() });
    expect(earlier.status).toBe(400);
    expect(earlier.body.details).toMatchObject({ field: "effective_from" });
    expect((await admin("POST", "/v1/pricing-rules", { rule_key: "hh", body: { ...body, name: "Happy hour 2" } })).status).toBe(201);
    const listed = await call<{ data: { version: number; status: string }[] }>("GET", "/v1/pricing-rules?rule_key=hh", { token: w.m.admin.token });
    const active = await call<{ data: { version: number }[] }>("GET", `/v1/pricing-rules?active_at=${new Date().toISOString()}`, { token: w.m.admin.token });
    expect(listed.body.data.find((r) => r.status === "active")!.version).toBe(active.body.data.find((r) => (r as unknown as { rule_key: string }).rule_key === "hh")!.version);
  });

  it("a correction can start now while a later version waits, and the waiting one takes over at its time", async () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    expect((await admin("POST", "/v1/pricing-rules", { rule_key: "lunch", body: { ...body, name: "Lunch" }, effective_from: new Date(Date.now() - 60_000).toISOString() })).status).toBe(201);
    expect((await admin("POST", "/v1/pricing-rules", { rule_key: "lunch", body: { ...body, name: "Lunch next week" }, effective_from: soon })).status).toBe(201);
    expect((await admin("POST", "/v1/pricing-rules", { rule_key: "lunch", body: { ...body, name: "Lunch fixed" } })).status).toBe(201);
    const status = async () => (await call<{ data: { version: number; status: string }[] }>("GET", "/v1/pricing-rules?rule_key=lunch", { token: w.m.admin.token })).body.data.filter((r) => r.status === "active" || r.status === "scheduled").map((r) => [r.version, r.status]);
    expect(await status()).toEqual([[3, "active"], [2, "scheduled"]]);
    await withTransaction(() => activateDueRules(new Date(Date.now() + 7_200_000)));
    expect(await status()).toEqual([[2, "active"]]);
  });

  it("sold out until a time that has passed is refused", async () => {
    const r = await call<Err>("POST", "/v1/stock/sold-out", { token: w.pins.cashier, body: { outlet_id: w.m.outletId, product_id: w.ids.wine, until: new Date(Date.now() - 60_000).toISOString() } });
    expect(r.status).toBe(400);
    expect(r.body.details).toEqual({ field: "until" });
  });
});

describe("what staff are told when something is refused", () => {
  it("a refusal for role says who may do it in words, and keeps the operation for clients", async () => {
    const order = await orderHelpers(call, w).orderWith(w.pins.server, [{ product_id: w.ids.kopi }]);
    const pay = await call<Err>("POST", `/v1/checks/${order.checks[0]!.id}/payments`, { token: w.pins.server, body: { payment_id: randomUUID(), tender_type_id: w.ids.cash, amount: order.balance } });
    expect(pay.status).toBe(403);
    expect(pay.body.message).toBe("Only a Cashier or above can do this");
    expect(pay.body.message).not.toMatch(/payments\./);
    expect(pay.body.details).toMatchObject({ action: "payments.record", required_role: "cashier" });
    expect((await call<Err>("GET", "/v1/staff", { token: w.stationToken })).body.message).toBe("Sign in with your PIN to do this");
    const name = await call<Err>("POST", "/v1/orders", { token: w.pins.cashier, body: { order_id: randomUUID(), order_type: "takeaway", takeaway_ref: "x".repeat(41) } });
    expect(name.status).toBe(400);
    expect(name.body.message).toBe("Takeaway ref can have at most 40 characters");
    const price = await admin("POST", "/v1/products", { name: "Gold leaf", price: 10 ** 13 });
    expect(price.body.message).toBe("Price is more than the largest amount the register accepts");
  });

  it("a sold-out item offers the restore remedy only to someone who may restore it", async () => {
    expect((await call("POST", "/v1/stock/sold-out", { token: w.pins.cashier, body: { outlet_id: w.m.outletId, product_id: w.ids.laksa, until: "today" } })).status).toBe(200);
    const h = orderHelpers(call, w);
    const add = async (token: string) => {
      const o = await h.open(token);
      return (await h.add(token, o.body.data.id, [{ product_id: w.ids.laksa }])).body as unknown as Err;
    };
    expect((await add(w.pins.server)).remedy).toBe("Choose something else.");
    expect((await add(w.pins.cashier)).remedy).toBe("Choose something else, or restore it from the sold-out list.");
    await call("POST", "/v1/stock/restore", { token: w.pins.cashier, body: { outlet_id: w.m.outletId, product_id: w.ids.laksa } });
  });
});
