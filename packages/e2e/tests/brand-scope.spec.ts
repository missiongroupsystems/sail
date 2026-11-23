import type { Page } from "@playwright/test";
import { devLocal, expect, register, test, TWIN_ADMIN, WEB } from "./fixtures";

/**
 * One active brand across the back office (run B). An outlet belongs to one brand; the scope picker always has a
 * brand chosen and offers that brand's outlets; pages follow it. The checks run on the Twin Group demo merchant: two
 * brands with two outlets each, built here through the register (the group, its first brand and outlet are seeded).
 */
type Twin = { brands: { A: string; B: string }; outlets: Record<"A1" | "A2" | "B1" | "B2", { id: string; name: string; paid: number; ref: string }> };
const NAMES = { A: "Harbour Noodles", B: "Quay Coffee", A1: "Harbour Noodles · Pier", A2: "Harbour Noodles · Market", B1: "Quay Coffee · Dock", B2: "Quay Coffee · Arcade" } as const;
/** An outlet's own name: what its chip shows once its brand is in scope. */
const ownName = (key: "A1" | "A2" | "B1" | "B2") => NAMES[key].slice(NAMES[key[0] as "A" | "B"].length + 3);
const twin = <T>(method: string, path: string, body?: unknown) => register<T>(method, path, body, TWIN_ADMIN);
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** The group as the tests need it; made once, and found again on a database that already has it. */
let built: Promise<Twin> | null = null;
function group(): Promise<Twin> {
  return (built ??= (async () => {
    const seeded = devLocal().twin;
    const brands = (await twin<{ data: { id: string; name: string }[] }>("GET", "/v1/brands")).data;
    const brandB = brands.find((b) => b.name === NAMES.B)?.id ?? (await twin<{ data: { id: string } }>("POST", "/v1/brands", { name: NAMES.B })).data.id;
    const ids = { A: seeded.brandId, B: brandB };
    const have = (await twin<{ data: { id: string; name: string }[] }>("GET", "/v1/outlets")).data;
    const outlet = async (key: "A1" | "A2" | "B1" | "B2") => have.find((o) => o.name === NAMES[key])?.id ?? (await twin<{ data: { id: string } }>("POST", "/v1/outlets", { name: NAMES[key], brand_id: ids[key[0] as "A" | "B"] })).data.id;
    const outletIds = { A1: seeded.outletId, A2: await outlet("A2"), B1: await outlet("B1"), B2: await outlet("B2") };

    const products = (await twin<{ data: { id: string; name: string }[] }>("GET", "/v1/products?limit=200")).data;
    const product = async (name: string, price: number, brand_id: string | null) => products.find((p) => p.name === name)?.id ?? (await twin<{ data: { id: string } }>("POST", "/v1/products", { name, price, brand_id })).data.id;
    const laksa = await product("Twin laksa", 1100, ids.A);
    const flatWhite = await product("Twin flat white", 700, ids.B);
    const water = await product("Twin water", 300, null);
    const menus = (await twin<{ data: { id: string; name: string }[] }>("GET", "/v1/menus")).data;
    const menu = async (name: string, brand_id: string, items: string[]) => menus.find((m) => m.name === name)?.id ?? (await twin<{ data: { id: string } }>("POST", "/v1/menus", { name, brand_id, sections: [{ name: "All", items: items.map((product_id) => ({ product_id })) }] })).data.id;
    const menuOf = { A: await menu("Twin noodle menu", ids.A, [laksa, water]), B: await menu("Twin coffee menu", ids.B, [flatWhite, water]) };
    const tenders = (await twin<{ data: { id: string; is_cash: boolean; provider?: string | null }[] }>("GET", "/v1/tender-types")).data;
    const byHand = tenders.find((t) => !t.is_cash && !t.provider)!;

    const out = {} as Twin["outlets"];
    for (const [key, qty] of [["A1", 1], ["A2", 2], ["B1", 3], ["B2", 4]] as const) {
      const id = outletIds[key];
      const brand = key[0] as "A" | "B";
      const links = (await twin<{ data: { outlet_id: string; channel: string }[] }>("GET", `/v1/channel-links?channel=pos&outlet_id=${id}`)).data;
      // No brand is sent for the channel: it takes its outlet's.
      if (!links.some((l) => l.outlet_id === id)) await twin("POST", "/v1/channel-links", { channel: "pos", outlet_id: id, menu_id: menuOf[brand] });
      const areas = (await twin<{ data: { id: string; name: string }[] }>("GET", `/v1/areas?outlet_id=${id}`)).data;
      if (!areas.some((a) => a.name === `Room ${key}`)) {
        const area = await twin<{ data: { id: string } }>("POST", "/v1/areas", { outlet_id: id, name: `Room ${key}` });
        await twin("POST", "/v1/tables", { outlet_id: id, area_id: area.data.id, name: `${key}-T1`, x: 0, y: 0, w: 2, h: 2 });
      }
      const printers = (await twin<{ data: { name: string }[] }>("GET", `/v1/printers?outlet_id=${id}`)).data;
      if (!printers.some((p) => p.name === `Printer ${key}`)) await twin("POST", "/v1/printers", { outlet_id: id, name: `Printer ${key}`, ip: `10.9.0.${qty}` });
      // One paid sale per outlet, each of a different amount, so a figure on a page says whose it is.
      const ref = `Sale ${key} ${String(Date.now()).slice(-5)}`;
      const order = await twin<{ data: { id: string } }>("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "takeaway", takeaway_ref: ref, outlet_id: id });
      const added = await twin<{ data: { balance: number; checks: { id: string }[] } }>("POST", `/v1/orders/${order.data.id}/lines`, { lines: [{ line_id: crypto.randomUUID(), product_id: brand === "A" ? laksa : flatWhite, quantity: qty }] });
      await twin("POST", `/v1/orders/${order.data.id}/fire`, {});
      await twin("POST", `/v1/checks/${added.data.checks[0]!.id}/payments`, { payment_id: crypto.randomUUID(), tender_type_id: byHand.id, amount: added.data.balance });
      await twin("POST", `/v1/orders/${order.data.id}/complete`, {}).catch(() => undefined);
      // What the outlet has taken in all, from the register: the figure its Sales report must show. (On a database
      // this spec has run on before there are earlier sales too; the amounts stay different outlet by outlet.)
      const summary = await twin<{ data: { totals: { total: number } } }>("GET", `/v1/reports/sales-summary?outlet_id=${id}`);
      out[key] = { id, name: NAMES[key], paid: summary.data.totals.total, ref };
    }
    return { brands: ids, outlets: out };
  })());
}

async function signIn(page: Page) {
  await page.goto(`${WEB}/login`);
  await expect(async () => {
    await page.getByLabel("Email").fill(TWIN_ADMIN);
    await page.getByLabel("Password").fill(devLocal().admin_password);
    await page.getByRole("button", { name: "Sign in" }).click({ timeout: 10_000 });
    await page.waitForURL(`${WEB}/today`, { timeout: 30_000 });
  }).toPass({ timeout: 300_000 });
}
/** Put a brand (and an outlet of it, or all of them) in scope, as the picker does. */
async function scopeTo(page: Page, brandId: string, outletId: string | null = null) {
  const r = await page.request.post(`${WEB}/api/prefs`, { data: { scope: { brandId, outletId } } });
  expect(r.ok()).toBe(true);
}
const outletsRow = (page: Page) => page.getByRole("navigation", { name: "Outlets" });
/** Choose an option of the open picker list, and wait until the choice is remembered (the page then reads it back). */
async function pick(page: Page, name: string) {
  await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/prefs") && r.ok()), page.getByRole("option", { name, exact: true }).click()]);
}

test.describe("brand scope", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("B3: the scope picker always has one brand, offers that brand's outlets, remembers the choice and falls back from a brand that is gone", async ({ page, context }) => {
    test.setTimeout(480_000);
    const g = await group();
    await signIn(page);
    const picker = page.getByRole("button", { name: /^Scope: / });

    await test.step("with nothing remembered, the first brand by name is chosen; there is no All brands", async () => {
      // Today works on one outlet: with all outlets in scope the picker names the one it shows, the brand's first.
      await expect(picker).toHaveAccessibleName(`Scope: Twin Group ▸ ${NAMES.A} ▸ ${NAMES.A2}`);
      await expect(async () => {
        await picker.click({ timeout: 5_000 });
        await expect(page.getByRole("dialog", { name: "Change scope" })).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 120_000 });
      const scope = page.getByRole("dialog", { name: "Change scope" });
      await scope.getByRole("button", { name: /Brand/ }).click();
      await expect(page.getByRole("option", { name: NAMES.A })).toBeVisible();
      await expect(page.getByRole("option", { name: NAMES.B })).toBeVisible();
      await expect(page.getByRole("option", { name: /All brands/ })).toHaveCount(0);
      // The brand already chosen: choosing it again changes nothing.
      await page.getByRole("option", { name: NAMES.A }).click();

      await scope.getByRole("button", { name: /Outlet/ }).click();
      await expect(page.getByRole("option")).toHaveText([`All outlets of ${NAMES.A}`, NAMES.A2, NAMES.A1]);
      // Market is the outlet Today shows, so the field already reads it: choose the other one.
      await pick(page, NAMES.A1);
      await expect(picker).toHaveAccessibleName(`Scope: Twin Group ▸ ${NAMES.A} ▸ ${NAMES.A1}`);
    });

    await test.step("another brand lists its own outlets and goes back to all of them", async () => {
      const scope = page.getByRole("dialog", { name: "Change scope" });
      await scope.getByRole("button", { name: /Brand/ }).click();
      await pick(page, NAMES.B);
      await expect(picker).toHaveAccessibleName(`Scope: Twin Group ▸ ${NAMES.B} ▸ ${NAMES.B2}`);
      await scope.getByRole("button", { name: /Outlet/ }).click();
      await expect(page.getByRole("option")).toHaveText([`All outlets of ${NAMES.B}`, NAMES.B2, NAMES.B1]);
      await pick(page, NAMES.B1);
      await expect(picker).toHaveAccessibleName(`Scope: Twin Group ▸ ${NAMES.B} ▸ ${NAMES.B1}`);
      await page.keyboard.press("Escape");
    });

    await test.step("the choice is there after a reload, and the page's outlet row is the brand's, with the chosen one marked", async () => {
      await page.goto(`${WEB}/floor`);
      await expect(picker).toHaveAccessibleName(`Scope: Twin Group ▸ ${NAMES.B} ▸ ${NAMES.B1}`);
      await expect(outletsRow(page).getByRole("button")).toHaveText([ownName("B2"), ownName("B1")]);
      await expect(outletsRow(page).getByRole("button", { name: ownName("B1") })).toHaveAttribute("aria-current", "true");
      await expect(page.getByRole("application", { name: "Floor plan for Room B1" })).toBeVisible();
    });

    await test.step("choosing in the row is the same choice: the picker follows, and the next page too", async () => {
      await expect(async () => {
        await outletsRow(page).getByRole("button", { name: ownName("B2") }).click({ timeout: 5_000 });
        await expect(page.getByRole("application", { name: "Floor plan for Room B2" })).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 120_000 });
      // The row remembers the choice as the picker does; the picker shows it once the page has read it back.
      await expect(picker).toHaveAccessibleName(`Scope: Twin Group ▸ ${NAMES.B} ▸ ${NAMES.B2}`);
      await page.goto(`${WEB}/printing/printers`);
      await expect(outletsRow(page).getByRole("button", { name: ownName("B2") })).toHaveAttribute("aria-current", "true");
    });

    await test.step("a remembered brand that is not there (archived, or not this merchant's) falls back the same way", async () => {
      const cookie = (await context.cookies(WEB)).find((c) => c.name === "sail_scope")!;
      await context.addCookies([{ ...cookie, value: JSON.stringify({ brandId: crypto.randomUUID(), outletId: g.outlets.B1.id }) }]);
      await page.goto(`${WEB}/floor`);
      await expect(picker).toHaveAccessibleName(`Scope: Twin Group ▸ ${NAMES.A} ▸ ${NAMES.A2}`);
      await expect(outletsRow(page).getByRole("button")).toHaveText([ownName("A2"), ownName("A1")]);
    });
  });

  test("B5: with all outlets in scope, a per-outlet page names the outlet it shows and a page for all outlets says all", async ({ page }) => {
    test.setTimeout(300_000);
    const g = await group();
    await signIn(page);
    await scopeTo(page, g.brands.A, null);
    const picker = page.getByRole("button", { name: /^Scope: / });
    const scope = page.getByRole("dialog", { name: "Change scope" });

    await test.step("Orders shows the brand's first outlet, and the trigger, the picker and the row all name it", async () => {
      await page.goto(`${WEB}/orders?range=all`);
      await expect(outletsRow(page).getByRole("button", { name: ownName("A2") })).toHaveAttribute("aria-current", "true");
      await expect(picker).toHaveAccessibleName(`Scope: Twin Group ▸ ${NAMES.A} ▸ ${NAMES.A2}`);
      await expect(picker).toContainText(NAMES.A);
      await expect(picker).toContainText(ownName("A2"));
      await expect(async () => {
        await picker.click({ timeout: 5_000 });
        await expect(scope).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 120_000 });
      await expect(scope.getByRole("button", { name: /Outlet/ })).toContainText(NAMES.A2);
      await page.keyboard.press("Escape");
    });

    await test.step("Products covers all outlets: it still reads All outlets", async () => {
      await page.goto(`${WEB}/menu/products`);
      await expect(picker).toHaveAccessibleName(`Scope: Twin Group ▸ ${NAMES.A} ▸ All outlets`);
      await expect(picker).toHaveText(NAMES.A);
      await expect(async () => {
        await picker.click({ timeout: 5_000 });
        await expect(scope).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 120_000 });
      await expect(scope.getByRole("button", { name: /Outlet/ })).toContainText(`All outlets of ${NAMES.A}`);
      await page.keyboard.press("Escape");
    });

    await test.step("Menus has nothing to choose for the brand: the brand in scope is its brand, with no label or control", async () => {
      await page.goto(`${WEB}/menu/menus`);
      await expect(page.getByRole("main").getByRole("button", { name: /Menu$/ })).toBeVisible();
      await expect(page.getByRole("button", { name: "Brand" })).toHaveCount(0);
      await expect(page.getByRole("main").getByText(/^Brand\b/)).toHaveCount(0);
    });
  });

  test("B6: a link to another brand's outlet follows it and its brand; an outlet the person cannot see is ignored", async ({ page }) => {
    test.setTimeout(300_000);
    const g = await group();
    await signIn(page);
    const picker = page.getByRole("button", { name: /^Scope: / });

    await test.step("a Sales link to Dock while Harbour Noodles is in scope shows Dock, under Quay Coffee", async () => {
      await scopeTo(page, g.brands.A, null);
      await page.goto(`${WEB}/reports/sales?outlet=${g.outlets.B1.id}`);
      await expect(picker).toHaveAccessibleName(`Scope: Twin Group ▸ ${NAMES.B} ▸ ${NAMES.B1}`);
      await expect(outletsRow(page).getByRole("button", { name: ownName("B1") })).toHaveAttribute("aria-current", "true");
      await expect(page.getByRole("main")).toContainText(money(g.outlets.B1.paid), { timeout: 60_000 });
    });

    await test.step("the next page stays with that brand and outlet", async () => {
      await expect(async () => {
        await page.goto(`${WEB}/menu/products`);
        await expect(picker).toHaveAccessibleName(`Scope: Twin Group ▸ ${NAMES.B} ▸ ${NAMES.B1}`, { timeout: 5_000 });
      }).toPass({ timeout: 60_000 });
    });

    await test.step("an outlet that is not one the person can see changes nothing", async () => {
      await scopeTo(page, g.brands.A, null);
      await page.goto(`${WEB}/reports/sales?outlet=${crypto.randomUUID()}`);
      await expect(picker).toHaveAccessibleName(`Scope: Twin Group ▸ ${NAMES.A} ▸ ${NAMES.A2}`);
      await expect(outletsRow(page).getByRole("button", { name: ownName("A2") })).toHaveAttribute("aria-current", "true");
    });
  });

  test("B4: with a brand chosen, Orders, Floor, Printing and the Sales report show that brand's outlets and figures, and Products its own and the shared ones", async ({ page }) => {
    test.setTimeout(600_000);
    const g = await group();
    await signIn(page);

    for (const brand of ["A", "B"] as const) {
      const mine = brand === "A" ? (["A1", "A2"] as const) : (["B1", "B2"] as const);
      const theirs = brand === "A" ? (["B1", "B2"] as const) : (["A1", "A2"] as const);
      await test.step(`brand ${NAMES[brand]}`, async () => {
        for (const key of mine) {
          await scopeTo(page, g.brands[brand], g.outlets[key].id);
          const own = g.outlets[key];
          const others = [...theirs, ...mine.filter((k) => k !== key)].map((k) => g.outlets[k]);

          await page.goto(`${WEB}/orders?range=all`);
          await expect(outletsRow(page).getByRole("button")).toHaveText(mine.map((k) => ownName(k)).sort((a, b) => a.localeCompare(b)));
          await expect(page.getByRole("main")).toContainText(own.ref, { timeout: 60_000 });
          for (const o of others) await expect(page.getByRole("main")).not.toContainText(o.ref);

          await page.goto(`${WEB}/floor`);
          await expect(page.getByRole("application", { name: `Floor plan for Room ${key}` }).getByRole("button", { name: new RegExp(`^${key}-T1,`) })).toBeVisible();
          for (const k of theirs) await expect(page.getByRole("main")).not.toContainText(`${k}-T1`);

          await page.goto(`${WEB}/printing/printers`);
          await expect(page.getByRole("main")).toContainText(`Printer ${key}`);
          for (const o of others) await expect(page.getByRole("main")).not.toContainText(`Printer ${o.name === NAMES.A1 ? "A1" : o.name === NAMES.A2 ? "A2" : o.name === NAMES.B1 ? "B1" : "B2"}`);

          // The outlet's sales are the one sale made at it: its amount, as the register took it, and no other outlet's.
          await page.goto(`${WEB}/reports/sales`);
          const byMethod = page.getByRole("grid", { name: "Sales by payment method" });
          await expect(byMethod).toContainText(money(own.paid), { timeout: 60_000 });
          for (const o of others) await expect(byMethod).not.toContainText(money(o.paid));
        }

        await scopeTo(page, g.brands[brand]);
        await page.goto(`${WEB}/menu/products`);
        const products = page.getByRole("grid", { name: "Products" });
        await expect(products.getByRole("row", { name: /Twin water/ })).toContainText("Shared");
        await expect(products.getByRole("row", { name: brand === "A" ? /Twin laksa/ : /Twin flat white/ })).toContainText(NAMES[brand]);
        await expect(products.getByRole("row", { name: brand === "A" ? /Twin flat white/ : /Twin laksa/ })).toHaveCount(0);

        await page.goto(`${WEB}/settings/channels`);
        const channels = page.getByRole("main");
        for (const k of mine) await expect(channels).toContainText(NAMES[k]);
        for (const k of theirs) await expect(channels).not.toContainText(NAMES[k]);
      });
    }
  });

  test("B4: the screens every brand shares say so, and list the same whichever brand is chosen", async ({ page }) => {
    test.setTimeout(480_000);
    const g = await group();
    await signIn(page);
    const seen: Record<string, string[]> = {};
    for (const brand of ["A", "B"] as const) {
      await scopeTo(page, g.brands[brand]);
      for (const path of ["/settings/tax", "/settings/payment-methods", "/settings/void-reasons", "/menu/categories", "/menu/modifiers", "/pricing/rules", "/pricing/customers"]) {
        await page.goto(`${WEB}${path}`);
        await expect(page.getByRole("note").filter({ hasText: "Shared by all brands" })).toBeVisible({ timeout: 120_000 });
        const rows = await page.getByRole("main").getByRole("rowheader").allInnerTexts();
        (seen[path] ??= []).push(rows.join("|"));
      }
    }
    for (const [path, lists] of Object.entries(seen)) expect(lists[1], `${path} lists the same for both brands`).toBe(lists[0]);
  });

  test("B1: an outlet has a required brand; Outlets shows it and Brands lists each brand's outlets", async ({ page }) => {
    test.setTimeout(300_000);
    const g = await group();
    await signIn(page);
    await scopeTo(page, g.brands.A);

    await page.goto(`${WEB}/settings/outlets`);
    const outlets = page.getByRole("grid");
    await expect(outlets.getByRole("row", { name: new RegExp(NAMES.A2) })).toContainText(NAMES.A);
    await expect(outlets.getByRole("row", { name: new RegExp(NAMES.B1) })).toContainText(NAMES.B);
    const sheet = page.getByRole("dialog", { name: "New outlet" });
    await expect(async () => {
      await page.getByRole("button", { name: "Add outlet" }).first().click({ timeout: 5_000 });
      await expect(sheet).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 120_000 });
    // Two brands: none is assumed, and the outlet cannot be saved without one.
    await expect(sheet.getByRole("button", { name: /Brand/ })).toContainText("Choose a brand");
    await sheet.getByRole("textbox", { name: "Name", exact: true }).fill("Not saved");
    await sheet.getByRole("button", { name: "Add outlet" }).click();
    await expect(sheet.getByText("Choose a brand").last()).toBeVisible();
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(sheet).toBeHidden();

    // An outlet that has orders and channels keeps its brand: the sheet names it and offers no other.
    const edit = page.getByRole("dialog", { name: NAMES.A1 });
    await expect(async () => {
      await outlets.getByRole("row", { name: new RegExp(NAMES.A1) }).click({ timeout: 5_000 });
      await expect(edit).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 120_000 });
    await expect(edit.getByRole("definition").filter({ hasText: NAMES.A })).toBeVisible();
    await expect(edit.getByRole("term").filter({ hasText: "Brand" })).toBeVisible();
    await expect(edit.getByRole("button", { name: /Brand/ })).toHaveCount(0);
    await edit.getByRole("button", { name: "Cancel" }).click();

    // A station's sheet names its outlet's brand as text, with nothing to choose.
    await scopeTo(page, g.brands.A, g.outlets.A1.id);
    await page.goto(`${WEB}/settings/stations`);
    await expect(async () => {
      await page.getByRole("button", { name: "Add station" }).first().click({ timeout: 5_000 });
      await expect(page.getByRole("dialog", { name: "New station" })).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 120_000 });
    const station = page.getByRole("dialog", { name: "New station" });
    await expect(station.getByRole("definition").filter({ hasText: NAMES.A })).toBeVisible();
    await expect(station.getByRole("button", { name: /Brand/ })).toHaveCount(0);
    await station.getByRole("button", { name: "Cancel" }).click();

    await page.goto(`${WEB}/settings/brands`);
    const brands = page.getByRole("grid");
    await expect(brands.getByRole("row", { name: new RegExp(NAMES.A) })).toContainText(`${NAMES.A2}, ${NAMES.A1}`);
    await expect(brands.getByRole("row", { name: new RegExp(NAMES.B) })).toContainText(`${NAMES.B2}, ${NAMES.B1}`);
  });
});
