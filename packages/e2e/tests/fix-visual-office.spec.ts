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
      await expect(page.getByRole("row", { name: new RegExp(name) })).toBeVisible();

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
});
