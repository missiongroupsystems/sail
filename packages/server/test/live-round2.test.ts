import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootWorld, orderHelpers, type Call, type World } from "./world.js";
import type { TestDb } from "./helpers.js";

/** Findings from the second live test that live in the register. */
let db: TestDb;
let call: Call;
let w: World;
let h: ReturnType<typeof orderHelpers>;

beforeAll(async () => {
  ({ db, call, w } = await bootWorld());
  h = orderHelpers(call, w);
});
afterAll(async () => db.drop());

type Z = {
  sales: { total: number };
  tenders: { amount: number; is_cash: boolean }[];
  cash: { float: number; cash_payments: number; expected: number; counted: number | null; variance: number | null; open_shifts: { count: number; float: number; expected: number } };
  reconciliation: { tenders: number; sales_total: number; paid_on_other_orders: number; paid_elsewhere: number };
};

describe("Z-report drawers and station scope", () => {
  it("cash variance covers the closed shifts only; an open drawer is listed apart (E-N1), and a station's report reconciles when it took payment for another station's order (C-2)", async () => {
    const s1 = await call<{ data: { id: string } }>("POST", "/v1/shifts", { token: w.pins.cashier, body: { float_cents: 10_000 } });
    expect(s1.status, JSON.stringify(s1.body)).toBe(201);
    const s2 = await call<{ data: { id: string } }>("POST", "/v1/shifts", { token: w.pins.cashierStation2, body: { float_cents: 5_000 } });
    expect(s2.status, JSON.stringify(s2.body)).toBe(201);
    // Station 2 opens and sends an order; station 1 takes the cash for it.
    const o = await h.orderWith(w.pins.cashierStation2, [{ product_id: w.ids.laksa }]);
    await h.fire(w.pins.cashierStation2, o.id);
    const paid = await h.pay(w.pins.cashier, o.checks[0]!.id, { tender_type_id: w.ids.cash, amount: o.balance });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    // Station 2 takes some cash of its own, so its open drawer has more than its float.
    const o2 = await h.orderWith(w.pins.cashierStation2, [{ product_id: w.ids.kopi }]);
    await h.fire(w.pins.cashierStation2, o2.id);
    expect((await h.pay(w.pins.cashierStation2, o2.checks[0]!.id, { tender_type_id: w.ids.cash, amount: o2.balance })).status).toBe(200);
    for (const id of [o.id, o2.id]) await call("POST", `/v1/orders/${id}/complete`, { token: w.pins.cashier, body: {} });

    const drawer1 = 10_000 + o.balance;
    const closed = await call("POST", `/v1/shifts/${s1.body.data.id}/close`, { token: w.pins.cashier, body: { counted_cash_cents: drawer1 } });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    const day = await call<{ data: Z }>("GET", `/v1/outlets/${w.m.outletId}/z-report`, { token: w.m.manager.token });
    expect(day.status).toBe(200);
    expect(day.body.data.cash).toMatchObject({ float: 10_000, cash_payments: o.balance, expected: drawer1, counted: drawer1, variance: 0, open_shifts: { count: 1, float: 5_000, expected: 5_000 + o2.balance } });

    const st1 = await call<{ data: Z }>("GET", `/v1/outlets/${w.m.outletId}/z-report?station_id=${w.ids.station}`, { token: w.m.manager.token });
    const r = st1.body.data;
    const tenders = r.tenders.reduce((s, t) => s + t.amount, 0);
    expect(tenders).toBe(o.balance);
    expect(r.sales.total).toBe(tenders);
    expect(r.reconciliation).toMatchObject({ paid_on_other_orders: 0, paid_elsewhere: 0 });
    const st2 = await call<{ data: Z }>("GET", `/v1/outlets/${w.m.outletId}/z-report?station_id=${w.ids.station2}`, { token: w.m.manager.token });
    expect(st2.body.data.sales.total).toBe(o2.balance);
    expect(st2.body.data.tenders.reduce((s, t) => s + t.amount, 0)).toBe(o2.balance);
    expect(st2.body.data.cash).toMatchObject({ float: 0, counted: null, variance: null, open_shifts: { count: 1, float: 5_000 } });
    void randomUUID;
  });
});

describe("unpairing from the device (A-R1-1)", () => {
  it("ends the pairing on the server: the token is refused and the back office shows the station not paired", async () => {
    const code = await call<{ data: { code: string } }>("POST", `/v1/stations/${w.ids.station2}/pairing-code`, { token: w.m.admin.token, body: {} });
    const paired = await call<{ data: { station_token: string } }>("POST", "/v1/stations/pair", { body: { code: code.body.data.code, device_label: "Spare iPad" }, idempotencyKey: null });
    const token = paired.body.data.station_token;
    const pin = await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token, body: { pin: "333333" } });
    expect(pin.status).toBe(201);
    const r = await call<{ data: { unpaired: boolean } }>("POST", "/v1/stations/unpair", { token, body: {} });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await call("POST", "/v1/stations/sessions", { token, body: { pin: "333333" } })).status).toBe(401);
    expect((await call("GET", "/v1/merchant", { token: pin.body.data.session_token })).status).toBe(401);
    const list = await call<{ data: { id: string; paired: boolean; device_label: string | null }[] }>("GET", `/v1/outlets/${w.m.outletId}/stations`, { token: w.m.admin.token });
    expect(list.body.data.find((s) => s.id === w.ids.station2)).toMatchObject({ paired: false, device_label: null });
    // A PIN session cannot unpair the station it is on: only the device's own station token can.
    expect((await call("POST", "/v1/stations/unpair", { token: w.pins.cashier, body: {} })).status).toBe(403);
  });
});

describe("availability windows past midnight (E-N3)", () => {
  it("22:00 to 02:00 is open at 23:00 and 01:00 in the merchant's zone, closed at 21:59 and 02:00; the next day counts for the early hours", async () => {
    const { inAvailabilityWindow } = await import("../src/services/menu.js");
    const { localParts } = await import("@sail/shared");
    const zone = "Asia/Singapore";
    const at = (iso: string) => {
      const l = localParts(new Date(iso), zone);
      return { time: l.time.slice(0, 5), dow: new Date(`${l.date}T00:00:00Z`).getUTCDay() };
    };
    const friday = { startTime: "22:00", endTime: "02:00", daysOfWeek: [5] };
    const open = (iso: string, r = friday) => { const x = at(iso); return inAvailabilityWindow(r, x.time, x.dow); };
    // Friday 13 Nov 2026 and Saturday 14 Nov in Singapore (UTC+8).
    expect(open("2026-11-13T15:00:00Z")).toBe(true); // Fri 23:00
    expect(open("2026-11-13T17:00:00Z")).toBe(true); // Sat 01:00
    expect(open("2026-11-13T13:59:00Z")).toBe(false); // Fri 21:59
    expect(open("2026-11-13T18:00:00Z")).toBe(false); // Sat 02:00
    expect(open("2026-11-14T15:00:00Z")).toBe(false); // Sat 23:00: Saturday is not a day of the rule
    expect(open("2026-11-12T17:00:00Z")).toBe(false); // Fri 01:00 belongs to Thursday night
    const everyDay = { startTime: "22:00", endTime: "02:00", daysOfWeek: [] };
    expect(open("2026-11-14T17:30:00Z", everyDay)).toBe(true); // Sun 01:30
    expect(open("2026-11-14T06:00:00Z", everyDay)).toBe(false); // Sat 14:00
    // A plain daytime window is unchanged.
    expect(open("2026-11-13T03:00:00Z", { startTime: "11:00", endTime: "15:00", daysOfWeek: [] })).toBe(true);
    expect(open("2026-11-13T07:00:00Z", { startTime: "11:00", endTime: "15:00", daysOfWeek: [] })).toBe(false);
  });

  it("an overnight window saves; one that ends when it starts is refused with a plain message", async () => {
    const ok = await call("POST", "/v1/availability-rules", { token: w.m.admin.token, body: { target_kind: "product", target_id: w.ids.wine, start_time: "22:00", end_time: "02:00" } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const bad = await call<{ message: string; remedy: string }>("POST", "/v1/availability-rules", { token: w.m.admin.token, body: { target_kind: "product", target_id: w.ids.wine, start_time: "10:00", end_time: "10:00" } });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe("The window ends when it starts");
    await call("DELETE", `/v1/availability-rules/${(ok.body as { data: { id: string } }).data.id}`, { token: w.m.admin.token, body: {} });
  });
});

describe("common passwords (E-M13)", () => {
  it("refuses the most common passwords and ones built on the email name, with a plain message; a passphrase is fine", async () => {
    const { checkPassword } = await import("../src/auth/identity.js");
    const refused = (pw: string, email?: string) => {
      try {
        checkPassword(pw, email);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(refused("password1234")).toBe("That password is one of the most common ones");
    expect(refused("P@ssw0rd2026!")).toBe("That password is one of the most common ones");
    expect(refused("qwerty123456")).toBe("That password is one of the most common ones");
    expect(refused("iloveyou2026")).toBe("That password is one of the most common ones");
    expect(refused("jordan.baker.2026", "Jordan.Baker@example.com")).toBe("That password contains your email name");
    expect(refused("purple dragon river")).toBeNull();
    expect(refused("correct horse battery")).toBeNull();
    expect(refused("a long enough password")).toBeNull();
    expect(refused("yellow harbour kite", "ada@example.com")).toBeNull();
  });

  it("a password change is refused when the new password holds the account's email name", async () => {
    const email = `mia.manager@${w.m.merchantId.slice(0, 8)}.test`;
    const { hashSecret } = await import("../src/auth/tokens.js");
    await db.sql`insert into backoffice_logins (staff_id, merchant_id, email, password_hash, password_changed_at) values (${w.m.manager.id}, ${w.m.merchantId}, ${email}, ${hashSecret("whatever it is")}, now())`;
    const r = await call<{ message: string }>("POST", "/v1/auth/password", { token: w.m.manager.token, body: { current_password: "whatever it is", new_password: "mia.manager forever" } });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("That password contains your email name");
  });
});

describe("drawer amounts (B-N6)", () => {
  it("an opening float above what the cash counter can hold is refused in plain words", async () => {
    const { drawerCap, REGION_PRESETS } = await import("@sail/shared");
    const cap = drawerCap(REGION_PRESETS.sg.cash_denominations);
    const r = await call<{ message: string; remedy: string }>("POST", "/v1/shifts", { token: w.pins.manager, body: { float_cents: 9_999_999_900, dry_run: true } });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/^The opening float can be at most /);
    expect(r.body.remedy).toBe("Check the amount: that is more than a drawer holds.");
    expect((await call("POST", "/v1/shifts", { token: w.pins.manager, body: { float_cents: cap, dry_run: true } })).status).not.toBe(400);
  });
});

describe("plain validation messages (E-M11, E-L5)", () => {
  it("a negative tax rate and a negative imported price read as words, not validator text", async () => {
    const r = await call<{ message: string }>("POST", "/v1/tax-classes", { token: w.m.admin.token, body: { name: "Negative", components: [{ name: "VAT", bps: -1 }] } });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("The rate cannot be negative");
    const { plainIssue } = await import("../src/lib/openapi.js");
    expect(plainIssue({ code: "too_small", origin: "number", minimum: 0, inclusive: true, path: ["float_cents"], message: "x", input: -1 } as never)).toBe("The opening float cannot be negative");
  });
});

describe("approval refusals name the right role (B-N5, A-R1-8, C-7, A-N8)", () => {
  it("a wrong PIN, a PIN whose role is too low and one's own PIN each get their own two-sentence message", async () => {
    const o = await h.orderWith(w.pins.server, [{ product_id: w.ids.kopi }]);
    const ask = (pin: string) => call<{ message: string; remedy: string }>("POST", "/v1/overrides", { token: w.pins.server, body: { action: "payments.record", target_kind: "order", target_id: o.id, approver_pin: pin, args: { check_id: o.checks[0]!.id, tender_type_id: w.ids.cash, amount: o.balance, tip_cents: 0, reference: null } } });
    const wrong = await ask("987654");
    expect(wrong.body).toMatchObject({ message: "PIN not recognised", remedy: "Check the PIN, or ask a Cashier or above to enter theirs." });
    const own = await ask("444444");
    expect(own.body).toMatchObject({ message: "You cannot approve your own action", remedy: "Ask a Cashier or above to enter their PIN." });
    const voidAsk = await call<{ message: string; remedy: string }>("POST", "/v1/overrides", { token: w.pins.server, body: { action: "orders.reopen", target_kind: "order", target_id: o.id, approver_pin: "333333", args: {} } });
    expect(voidAsk.body).toMatchObject({ message: "That PIN is a Cashier's, and this needs a Manager or above", remedy: "Ask a Manager or above to enter their PIN." });
  });
});

describe("an outlet filter for an outlet one cannot see (F notes)", () => {
  it("is refused rather than answered with the merchant's own rows", async () => {
    expect((await call("GET", `/v1/categories?outlet_id=${randomUUID()}`, { token: w.m.admin.token })).status).toBe(404);
    expect((await call("GET", `/v1/tender-types?outlet_id=${randomUUID()}`, { token: w.m.admin.token })).status).toBe(404);
    expect((await call("GET", `/v1/tender-types?outlet_id=${w.m.outletId}`, { token: w.m.admin.token })).status).toBe(200);
  });
});

describe("set-password link names its account (F-N4)", () => {
  it("inspecting a live link gives the name and email without using it; a dead one is refused", async () => {
    const id = randomUUID();
    expect((await call("POST", "/v1/staff", { token: w.m.admin.token, body: { id, name: "Nia Newhire", email: "nia.newhire@example.test", role: "server" } })).status).toBe(201);
    const link = await call<{ data: { url: string } }>("POST", `/v1/staff/${id}/invite`, { token: w.m.admin.token, body: {} });
    expect(link.status, JSON.stringify(link.body)).toBe(201);
    const token = new URL(link.body.data.url).hash.replace(/^#token=/, "");
    const seen = await call<{ data: { kind: string; name: string; email: string } }>("POST", "/v1/auth/links/inspect", { body: { token }, idempotencyKey: null });
    expect(seen.status, JSON.stringify(seen.body)).toBe(200);
    expect(seen.body.data).toEqual({ kind: "invite", name: "Nia Newhire", email: "nia.newhire@example.test" });
    // Inspecting does not use the link: it still sets the password.
    expect((await call("POST", "/v1/auth/links/accept", { body: { token, password: "yellow harbour kite" }, idempotencyKey: null })).status).toBe(201);
    expect((await call("POST", "/v1/auth/links/inspect", { body: { token }, idempotencyKey: null })).status).toBe(404);
  });
});

describe("availability patch (review)", () => {
  it("changing one end to equal the stored other end is refused", async () => {
    const r = await call<{ data: { id: string } }>("POST", "/v1/availability-rules", { token: w.m.admin.token, body: { target_kind: "product", target_id: w.ids.kopi, start_time: "09:00", end_time: "11:00" } });
    expect(r.status).toBe(201);
    const bad = await call<{ message: string }>("PATCH", `/v1/availability-rules/${r.body.data.id}`, { token: w.m.admin.token, body: { end_time: "09:00" } });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe("The window ends when it starts");
    await call("DELETE", `/v1/availability-rules/${r.body.data.id}`, { token: w.m.admin.token, body: {} });
  });
});
