import type { Page } from "@playwright/test";
import { API, devLocal, expect, SG_ADMIN, test, WEB } from "./fixtures";

/** Fill the sign-in form and press Sign in until the dev server's first compile has hydrated it. */
async function signIn(page: Page, email: string, password: string) {
  await page.goto(`${WEB}/login`);
  await expect(async () => {
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click({ timeout: 10_000 });
    await page.waitForURL(`${WEB}/today`, { timeout: 30_000 });
  }).toPass({ timeout: 300_000 });
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
}

async function sessionToken(page: Page): Promise<string> {
  const cookie = (await page.context().cookies(WEB)).find((c) => c.name === "sail_session");
  expect(cookie, "the session cookie").toBeDefined();
  return cookie!.value;
}

const meStatus = async (token: string) => (await fetch(`${API}/v1/me`, { headers: { authorization: `Bearer ${token}` } })).status;

test("back office: a wrong password is refused, the right one signs in, and signing out ends the session", async ({ page, watch }) => {
  test.setTimeout(600_000);
  watch.allow({ status: 401, url: /\/api\/session$/, why: "the wrong password on purpose" });
  await page.goto(`${WEB}/login`);
  // The form's own alert, not Next's route announcer. Retry only until the hydrated form has sent one attempt: each
  // wrong attempt counts towards the email's lockout, which the later specs' Admin sign-ins would hit.
  const refusal = page.locator("form").getByRole("alert");
  await expect(async () => {
    if ((await refusal.count()) === 0) {
      await page.getByLabel("Email").fill(SG_ADMIN);
      await page.getByLabel("Password").fill("not the demo password");
      await page.getByRole("button", { name: "Sign in" }).click({ timeout: 10_000 });
    }
    await expect(refusal).toBeVisible({ timeout: 20_000 });
  }).toPass({ timeout: 300_000 });
  await expect(refusal).toContainText("Email or password not recognised");

  await signIn(page, SG_ADMIN, devLocal().admin_password);
  const token = await sessionToken(page);
  expect(await meStatus(token)).toBe(200);

  await page.getByRole("button", { name: /Open user menu/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.waitForURL(/\/login/);
  // The register ended the session too, not only the browser's cookie.
  expect(await meStatus(token)).toBe(401);
  await page.goto(`${WEB}/today`);
  await page.waitForURL(/\/login/);
});

test("back office: an Admin invites a staff member, who sets a password in another browser; revoking signs them out", async ({ browser, page, watch }) => {
  test.setTimeout(900_000);
  const suffix = String(Date.now()).slice(-6);
  const email = `invited.${suffix}@sail.local`;
  const name = `Invited Manager ${suffix}`;
  await signIn(page, SG_ADMIN, devLocal().admin_password);

  let link = "";
  await test.step("the Admin adds the staff member with a POS PIN and copies an invite link", async () => {
    await page.goto(`${WEB}/team`);
    await page.getByRole("button", { name: "Add staff member" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByLabel("Name").fill(name);
    await sheet.getByLabel("Email").fill(email);
    await sheet.getByRole("button", { name: /Role/ }).click();
    await page.getByRole("option", { name: /^Manager/ }).click();
    await sheet.getByLabel("PIN (optional)").fill(suffix);
    await sheet.getByRole("button", { name: "Add staff member" }).click();
    await expect(sheet).toBeHidden();
    await page.getByRole("rowheader", { name: name }).click();
    const edit = page.getByRole("dialog", { name });
    await expect(edit.getByText("No back-office access.")).toBeVisible();
    await edit.getByRole("button", { name: "Invite to the back office" }).click();
    const field = edit.getByLabel("Link for this person (shown once)");
    await expect(field).toHaveValue(/\/set-password#token=/);
    link = await field.inputValue();
    await expect(edit.getByText(/^Invited; the link works until/)).toBeVisible();
  });

  const invitee = await browser.newContext();
  const theirs = await invitee.newPage();
  watch.attach(theirs);
  await test.step("the invitee opens the link in their own browser and sets a password", async () => {
    await theirs.goto(link);
    await expect(theirs.getByRole("heading", { name: "Set your password" })).toBeVisible({ timeout: 180_000 });
    // The token leaves the address bar once read.
    await expect.poll(() => theirs.url()).not.toContain("token=");
    await expect(async () => {
      await theirs.getByLabel("New password").fill("invited manager password");
      await theirs.getByLabel("Type it again").fill("invited manager password");
      await theirs.getByRole("button", { name: "Set password and sign in" }).click({ timeout: 10_000 });
      await theirs.waitForURL(`${WEB}/today`, { timeout: 30_000 });
    }).toPass({ timeout: 300_000 });
    await expect(theirs.getByRole("button", { name: new RegExp(`^${name}, Manager`) })).toBeVisible();
  });

  await test.step("the Admin sees them signed up, then revokes their access", async () => {
    await page.reload();
    await page.getByRole("rowheader", { name: name }).click();
    const edit = page.getByRole("dialog", { name });
    await expect(edit.getByText(`Can sign in as ${email}.`)).toBeVisible();
    await edit.getByRole("button", { name: "Revoke access" }).click();
    await expect(edit.getByText("No back-office access.")).toBeVisible();
  });

  await test.step("the invitee's session has ended", async () => {
    await theirs.goto(`${WEB}/today`);
    await theirs.waitForURL(/\/login\?expired=1/);
  });
  await invitee.close();
});
