import type { Page } from "@playwright/test";
import { devLocal, EU_ADMIN, expect, register, test, TWIN_ADMIN, WEB } from "./fixtures";

/**
 * The back office of a one-brand merchant (the EU café: one brand, one outlet), after the final visual review: a new
 * outlet does not take over the per-outlet pages, and no brand is shown or offered where there is only one.
 */
const eu = <T>(method: string, path: string, body?: unknown) => register<T>(method, path, body, EU_ADMIN);

const twin = <T>(method: string, path: string, body?: unknown) => register<T>(method, path, body, TWIN_ADMIN);

async function signIn(page: Page, email = EU_ADMIN) {
  await page.goto(`${WEB}/login`);
  await expect(async () => {
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(devLocal().admin_password);
    await page.getByRole("button", { name: "Sign in" }).click({ timeout: 10_000 });
    await page.waitForURL(`${WEB}/today`, { timeout: 30_000 });
  }).toPass({ timeout: 300_000 });
}

test.describe("one-brand back office", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("no Brand column on Outlets, Stations and Channels, no Brand select on a product, a quiet Archive outlet…", async ({ page }) => {
    test.setTimeout(300_000);
    const brands = (await eu<{ data: { archived: boolean }[] }>("GET", "/v1/brands")).data;
    test.skip(brands.length !== 1, "the EU café has one brand");
    await signIn(page);
    for (const path of ["/settings/outlets", "/settings/stations", "/settings/channels"]) {
      await page.goto(`${WEB}${path}`);
      const table = page.getByRole("grid").or(page.getByRole("table")).first();
      await expect(table.getByRole("columnheader").first()).toBeVisible();
      await expect(table.getByRole("columnheader", { name: "Brand" }), path).toHaveCount(0);
    }

    await page.goto(`${WEB}/settings/outlets`);
    await page.getByRole("row").nth(1).click();
    const outletSheet = page.getByRole("dialog");
    const archive = outletSheet.getByRole("button", { name: "Archive outlet…" });
    await expect(archive).toBeVisible();
    // The quiet secondary its neighbours use, not a second filled button.
    expect(await archive.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await outletSheet.getByRole("button", { name: "Cancel" }).evaluate((el) => getComputedStyle(el).backgroundColor));
    await outletSheet.getByRole("button", { name: "Cancel" }).click();

    await page.goto(`${WEB}/menu/products`);
    await page.getByRole("button", { name: "Add product" }).first().click();
    const productSheet = page.getByRole("dialog", { name: /product/i });
    await expect(productSheet.getByRole("button", { name: /Category/ })).toBeVisible();
    await expect(productSheet.getByRole("button", { name: /^Brand/ })).toHaveCount(0);
    await expect(productSheet.getByText("Shared by all brands")).toHaveCount(0);
  });

  test("adding an outlet keeps the per-outlet pages on the outlet they were showing, though the new one sorts first", async ({ page }) => {
    test.setTimeout(300_000);
    const name = `Aa new ${String(Date.now()).slice(-6)}`;
    const before = (await eu<{ data: { id: string; name: string }[] }>("GET", "/v1/outlets")).data;
    test.skip(before.length !== 1, "the EU café starts with one outlet");
    try {
      await signIn(page);
      await page.goto(`${WEB}/settings/outlets`);
      await page.getByRole("button", { name: "Add outlet" }).first().click();
      const sheet = page.getByRole("dialog", { name: "New outlet" });
      await sheet.getByLabel("Name").fill(name);
      await sheet.getByRole("button", { name: "Add outlet" }).click();
      await expect(sheet).toBeHidden();
      // It opens when the café's outlet does, not closed all week.
      await expect(page.getByRole("row", { name: new RegExp(name) })).toBeVisible();
      await expect(page.getByRole("row", { name: new RegExp(name) })).not.toContainText("Closed");

      for (const path of ["/settings/stations", "/today"]) {
        await page.goto(`${WEB}${path}`);
        const row = page.getByRole("navigation", { name: "Outlets" });
        await expect(row.getByRole("button", { name })).toBeVisible();
        await expect(row.getByRole("button", { name }), path).not.toHaveAttribute("aria-current", "true");
        await expect(row.locator('[aria-current="true"]'), path).toHaveCount(1);
      }
    } finally {
      // The EU café goes back to one live outlet for the specs after this one.
      const added = (await eu<{ data: { id: string; name: string }[] }>("GET", "/v1/outlets")).data.find((o) => o.name === name);
      if (added) await eu("PATCH", `/v1/outlets/${added.id}`, { archived: true });
    }
  });
});

test.describe("two-brand back office", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the scope trigger never cuts off the outlet: Brand · Outlet when both fit, else the outlet's own name", async ({ page }) => {
    test.setTimeout(300_000);
    // The names brand-scope.spec.ts gives the group, found again when it has already made them.
    const brandA = devLocal().twin.brandId;
    const brands = (await twin<{ data: { name: string }[] }>("GET", "/v1/brands")).data;
    if (!brands.some((b) => b.name === "Quay Coffee")) await twin("POST", "/v1/brands", { name: "Quay Coffee" });
    const outlets = (await twin<{ data: { id: string; name: string }[] }>("GET", "/v1/outlets")).data;
    const market = outlets.find((o) => o.name === "Harbour Noodles · Market")?.id ?? (await twin<{ data: { id: string } }>("POST", "/v1/outlets", { name: "Harbour Noodles · Market", brand_id: brandA })).data.id;
    await signIn(page, TWIN_ADMIN);
    await page.request.post(`${WEB}/api/prefs`, { data: { scope: { brandId: brandA, outletId: market } } });
    for (const width of [1440, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${WEB}/today`);
      const trigger = page.getByRole("button", { name: /^Scope:/ }).first();
      await expect(trigger).toHaveAccessibleName("Scope: Twin Group ▸ Harbour Noodles ▸ Harbour Noodles · Market");
      const label = trigger.locator("span.truncate").first();
      await expect(label).toContainText("Market");
      const { text, cut } = await label.evaluate((el) => ({ text: el.firstChild?.textContent ?? "", cut: el.scrollWidth > el.clientWidth }));
      expect(cut, `${width}: "${text}" is cut off`).toBe(false);
      expect(["Harbour Noodles · Market", "Market"]).toContain(text);
    }
  });

  test("Floor & QR: a five-character table name reads whole on a default 2x2 tile", async ({ page }) => {
    test.setTimeout(300_000);
    const brandA = devLocal().twin.brandId;
    const outlets = (await twin<{ data: { id: string; name: string }[] }>("GET", "/v1/outlets")).data;
    const market = outlets.find((o) => o.name === "Harbour Noodles · Market")?.id ?? (await twin<{ data: { id: string } }>("POST", "/v1/outlets", { name: "Harbour Noodles · Market", brand_id: brandA })).data.id;
    // The room and table brand-scope.spec.ts gives this outlet.
    const areas = (await twin<{ data: { id: string; name: string }[] }>("GET", `/v1/areas?outlet_id=${market}`)).data;
    if (!areas.some((a) => a.name === "Room A2")) {
      const area = await twin<{ data: { id: string } }>("POST", "/v1/areas", { outlet_id: market, name: "Room A2" });
      await twin("POST", "/v1/tables", { outlet_id: market, area_id: area.data.id, name: "A2-T1", x: 0, y: 0, w: 2, h: 2 });
    }
    await signIn(page, TWIN_ADMIN);
    await page.request.post(`${WEB}/api/prefs`, { data: { scope: { brandId: brandA, outletId: market } } });
    await page.goto(`${WEB}/floor`);
    await page.getByRole("button", { name: "Room A2", exact: true }).click();
    const name = page.locator("span.font-heading", { hasText: "A2-T1" }).first();
    await expect(name).toBeVisible();
    expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth), "A2-T1 is cut off").toBe(true);
  });

  test("Changes: with a brand's outlets in scope, an order names its outlet; with one outlet chosen it does not", async ({ page }) => {
    test.setTimeout(300_000);
    const brandA = devLocal().twin.brandId;
    const outlets = (await twin<{ data: { id: string; name: string; brand_id: string }[] }>("GET", "/v1/outlets")).data.filter((o) => o.brand_id === brandA);
    test.skip(outlets.length < 2, "brand-scope.spec.ts gives the first brand two outlets");
    // One order at each of two outlets, so the list has one to name for each.
    for (const o of outlets.slice(0, 2)) await twin("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "takeaway", takeaway_ref: `Audit ${String(Date.now()).slice(-5)}`, outlet_id: o.id });
    await signIn(page, TWIN_ADMIN);
    await page.request.post(`${WEB}/api/prefs`, { data: { scope: { brandId: brandA, outletId: null } } });
    await page.goto(`${WEB}/audit?target=order`);
    const own = (name: string) => name.split(" · ").pop()!;
    for (const o of outlets.slice(0, 2)) await expect(page.getByRole("gridcell", { name: new RegExp(`^P-\\d+ · ${own(o.name)}$`) }).first()).toBeVisible();
    await page.request.post(`${WEB}/api/prefs`, { data: { scope: { brandId: brandA, outletId: outlets[0]!.id } } });
    await page.goto(`${WEB}/audit?target=order`);
    await expect(page.getByRole("gridcell", { name: /^P-\d+$/ }).first()).toBeVisible();
    await expect(page.getByRole("gridcell", { name: /^P-\d+ · / })).toHaveCount(0);
  });

  test("Outlet sheet: a brand change the register refuses shows its message at the Brand field", async ({ page, watch }) => {
    test.setTimeout(300_000);
    watch.allow({ status: 409, url: /\/v1\/outlets\/[^/]+$/, why: "the register's refusal, played on purpose" });
    const brandA = devLocal().twin.brandId;
    const brands = (await twin<{ data: { id: string; name: string }[] }>("GET", "/v1/brands")).data;
    if (!brands.some((b) => b.name === "Quay Coffee")) await twin("POST", "/v1/brands", { name: "Quay Coffee" });
    // An outlet with no orders and no channels, so the sheet offers its brand; the refusal is the register's own
    // (a brand-limited person's probe cannot see another brand's orders, R5), played here for an outlet it cannot see either.
    const spare = (await twin<{ data: { id: string } }>("POST", "/v1/outlets", { name: `Harbour Noodles · Spare ${String(Date.now()).slice(-5)}`, brand_id: brandA })).data.id;
    try {
      await page.route(`**/v1/outlets/${spare}`, (route) =>
        route.request().method() === "PATCH"
          ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "state_conflict", message: "This outlet has orders, so its brand cannot change", remedy: "Add a new outlet for the other brand, and archive this one when it is no longer used.", details: { reason: "outlet_has_orders", field: "brand_id" } }) })
          : route.continue(),
      );
      await signIn(page, TWIN_ADMIN);
      await page.request.post(`${WEB}/api/prefs`, { data: { scope: { brandId: brandA, outletId: null } } });
      await page.goto(`${WEB}/settings/outlets`);
      await page.getByRole("row", { name: /Spare/ }).click();
      const sheet = page.getByRole("dialog");
      const brand = sheet.getByRole("button", { name: /Brand/ });
      await brand.click();
      await page.getByRole("option", { name: "Quay Coffee" }).click();
      await sheet.getByRole("button", { name: "Save changes" }).click();
      // Under the select itself (the foot of the form repeats it), after the field's description.
      const message = sheet.getByText("This outlet has orders, so its brand cannot change").first();
      await expect(message).toBeVisible();
      const [select, said] = [await brand.boundingBox(), await message.boundingBox()];
      expect(said!.y - (select!.y + select!.height), "the message sits right under the Brand select").toBeLessThan(48);
      await page.screenshot({ path: "test-results/outlet-brand-refused.png" });
    } finally {
      await twin("PATCH", `/v1/outlets/${spare}`, { archived: true });
    }
  });

  test("a new brand with no outlet yet can be put in scope", async ({ page }) => {
    test.setTimeout(300_000);
    const name = `Bravo ${String(Date.now()).slice(-6)}`;
    const bravo = (await twin<{ data: { id: string } }>("POST", "/v1/brands", { name })).data.id;
    try {
      await signIn(page, TWIN_ADMIN);
      await page.request.post(`${WEB}/api/prefs`, { data: { scope: { brandId: bravo, outletId: null } } });
      await page.goto(`${WEB}/menu/products`);
      await expect(page.getByRole("button", { name: /^Scope:/ }).first()).toHaveAccessibleName(`Scope: Twin Group ▸ ${name} ▸ All outlets`);
    } finally {
      // The group goes back to its two brands for the specs after this one.
      await twin("PATCH", `/v1/brands/${bravo}`, { archived: true });
    }
  });
});
