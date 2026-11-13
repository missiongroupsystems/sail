import type { Page } from "@playwright/test";
import { devLocal, expect, register, SG_ADMIN, test, WEB } from "./fixtures";

/** Sign in as the seeded Admin; done once Today has rendered, so the next navigation is not cut short. */
async function signIn(page: Page) {
  await page.goto(`${WEB}/login`);
  await expect(async () => {
    await page.getByLabel("Email").fill(SG_ADMIN);
    await page.getByLabel("Password").fill(devLocal().admin_password);
    await page.getByRole("button", { name: "Sign in" }).click({ timeout: 10_000 });
    await page.waitForURL(`${WEB}/today`, { timeout: 30_000 });
  }).toPass({ timeout: 300_000 });
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
}

test.describe("back office configuration", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("archiving a station asks first and says its device is signed out; an archived station can be listed and restored", async ({ page }) => {
    test.setTimeout(300_000);
    const { outletId } = devLocal();
    const name = `Archive check ${String(Date.now()).slice(-6)}`;
    await register("POST", "/v1/stations", { name, kind: "pos", outlet_id: outletId, home: "floor", pay_before_firing: false, seats_enabled: false, brand_id: null });
    await signIn(page);
    await page.goto(`${WEB}/settings/stations`);
    const sheet = page.getByRole("dialog", { name });
    // A click before the dev server's first compile has hydrated the page does nothing: press until the sheet opens.
    await expect(async () => {
      await page.getByRole("rowheader", { name }).click({ timeout: 5_000 });
      await expect(sheet).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 120_000 });
    await sheet.getByRole("button", { name: "Archive station…" }).click();

    const confirm = page.getByRole("alertdialog", { name: `Archive ${name}?` });
    await expect(confirm).toContainText("restore it and pair a device afresh");
    await confirm.getByRole("button", { name: "Keep the station" }).click();
    await expect(confirm).toBeHidden();
    await expect(sheet).toBeVisible();

    await sheet.getByRole("button", { name: "Archive station…" }).click();
    await confirm.getByRole("button", { name: "Archive station" }).click();
    await expect(confirm).toBeHidden();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("rowheader", { name })).toHaveCount(0);

    // The list asks for archived stations too; a register that knows the flag returns them, one that does not lists the
    // active ones only. Restoring is checked wherever the register lists the archived station.
    const listed = await register<{ data: { name: string; archived: boolean }[] }>("GET", `/v1/outlets/${outletId}/stations?include_archived=true`);
    const archived = listed.data.find((s) => s.name === name);
    await page.getByText("Show archived", { exact: true }).click();
    if (archived) {
      expect(archived.archived).toBe(true);
      await page.getByRole("rowheader", { name }).click();
      await expect(sheet.getByText(/Restoring brings it back unpaired/)).toBeVisible();
      await sheet.getByRole("button", { name: "Restore station" }).click();
      await expect(sheet).toBeHidden();
      await page.getByText("Show archived", { exact: true }).click();
      await expect(page.getByRole("rowheader", { name })).toBeVisible();
    } else {
      await expect(page.getByRole("rowheader", { name })).toHaveCount(0);
    }
  });

  test("a negative tax rate is sent as typed and the register's refusal shows under the rate", async ({ page, watch }) => {
    test.setTimeout(300_000);
    // The refusal is the point of the test.
    watch.allow({ status: 400, url: /\/v1\/tax-classes$/, why: "the register refuses a negative rate" });
    await signIn(page);
    await page.goto(`${WEB}/settings/tax`);
    const sheet = page.getByRole("dialog", { name: "New tax class" });
    await expect(async () => {
      await page.getByRole("button", { name: "Add tax class" }).click({ timeout: 5_000 });
      await expect(sheet).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 120_000 });
    await sheet.getByLabel("Name", { exact: true }).fill(`Negative check ${String(Date.now()).slice(-6)}`);
    await sheet.getByLabel("Name on receipts").fill("Levy");
    const sent = page.waitForRequest((r) => r.method() === "POST" && /\/v1\/tax-classes$/.test(r.url()));
    await sheet.getByLabel("Rate").fill("-5");
    await sheet.getByRole("button", { name: "Add tax class" }).click();
    expect((await sent).postDataJSON().components[0].bps, "the minus sign is kept").toBe(-500);
    // Refused under the field and at the foot of the form; nothing is saved and the sheet stays open.
    await expect(sheet.getByRole("alert")).toBeVisible();
    await expect(sheet.getByLabel("Rate")).toHaveAttribute("aria-invalid", "true");
    await expect(sheet.getByLabel("Rate")).toHaveValue("-5");
    // A rate under 1% keeps its sign once the field is left.
    await sheet.getByLabel("Rate").fill("-0.5");
    await sheet.getByLabel("Name on receipts").focus();
    await expect(sheet.getByLabel("Rate")).toHaveValue("-0.5");
  });
});
