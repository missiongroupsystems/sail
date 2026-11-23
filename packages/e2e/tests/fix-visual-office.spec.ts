import type { Page } from "@playwright/test";
import { devLocal, EU_ADMIN, expect, register, test, WEB } from "./fixtures";

/**
 * The back office of a one-brand merchant (the EU café: one brand, one outlet), after the final visual review: a new
 * outlet does not take over the per-outlet pages, and no brand is shown or offered where there is only one.
 */
const eu = <T>(method: string, path: string, body?: unknown) => register<T>(method, path, body, EU_ADMIN);

async function signIn(page: Page) {
  await page.goto(`${WEB}/login`);
  await expect(async () => {
    await page.getByLabel("Email").fill(EU_ADMIN);
    await page.getByLabel("Password").fill(devLocal().admin_password);
    await page.getByRole("button", { name: "Sign in" }).click({ timeout: 10_000 });
    await page.waitForURL(`${WEB}/today`, { timeout: 30_000 });
  }).toPass({ timeout: 300_000 });
}

test.describe("one-brand back office", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

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
