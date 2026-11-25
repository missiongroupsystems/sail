import type { Page } from "@playwright/test";
import { API, expect, register, signInToken, test, WEB } from "./fixtures";

/**
 * The /x/ gate in a back office built with the test extension (extension.config.ts; packages/web/test/extension):
 * each page's role is checked on the server before the page renders, the refusal page names that role, and the rail
 * leaves out a section whose page is above the person's role.
 */

async function signInAs(page: Page, role: "cashier" | "manager" | "admin") {
  const suffix = `${role}${String(Date.now()).slice(-6)}`;
  const email = `${suffix}@sail.local`;
  const password = `quiet harbour lantern ${String(Date.now()).slice(-4)} round`;
  const created = await register<{ data: { id: string } }>("POST", "/v1/staff", { name: `Extension ${suffix}`, email, role });
  const link = await register<{ data: { url: string | null } }>("POST", `/v1/staff/${created.data.id}/invite`, {});
  const token = new URL(link.data.url!).hash.replace(/^#token=/, "");
  await fetch(`${API}/v1/auth/links/accept`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ token, password }) });
  const session = await signInToken(API, email, password);
  // A production build (next start) sets the session cookie Secure, and WebKit drops a Secure cookie on plain-http
  // localhost; Chromium keeps it. So WebKit gets the same token the form would have set, without Secure.
  if (page.context().browser()?.browserType().name() === "webkit") {
    await page.context().addCookies([{ name: "sail_session", value: session, url: WEB, httpOnly: true, sameSite: "Lax" }]);
    await page.goto(`${WEB}/today`);
    return;
  }
  await page.goto(`${WEB}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${WEB}/today`);
}

const rail = (page: Page, name: string) => page.getByRole("link", { name, exact: true });
const refusal = (page: Page) => page.getByRole("heading", { name: "This page needs a higher role" });

test("signed out, an extension page sends the person to sign in", async ({ page }) => {
  await page.goto(`${WEB}/x/managers`);
  await expect(page).toHaveURL(`${WEB}/login?next=%2Fx%2Fmanagers`);
});

test("a Cashier gets the refusal page naming the page's role, and the rail leaves out the sections above it", async ({ page, watch }) => {
  watch.allow({ status: 403, url: /\/x\//, why: "the refusal page answers 403" });
  await signInAs(page, "cashier");
  await expect(page).toHaveTitle(/Harbour/);
  await expect(rail(page, "Open")).toBeVisible();
  await expect(rail(page, "Managers")).toHaveCount(0);
  await expect(rail(page, "Admins")).toHaveCount(0);
  const res = await page.goto(`${WEB}/x/managers`);
  expect(res?.status()).toBe(403);
  await expect(refusal(page)).toBeVisible();
  await expect(page.getByText("This page needs a Manager or above.")).toBeVisible();
  await expect(page.getByText("An extension page")).toHaveCount(0);
  // A page every staff member may open.
  await page.goto(`${WEB}/x/open`);
  await expect(page.getByText("An extension page")).toBeVisible();
});

test("a Manager gets the Manager's page, and the refusal page for a page with no rail section above them", async ({ page, watch }) => {
  watch.allow({ status: 403, url: /\/x\/finance\/only/, why: "the refusal page answers 403" });
  await signInAs(page, "manager");
  await expect(rail(page, "Managers")).toBeVisible();
  await expect(rail(page, "Admins")).toHaveCount(0);
  await rail(page, "Managers").click();
  await expect(page).toHaveURL(`${WEB}/x/managers`);
  await expect(page.getByText("An extension page")).toBeVisible();
  await expect(refusal(page)).toHaveCount(0);
  const res = await page.goto(`${WEB}/x/finance/only`);
  expect(res?.status()).toBe(403);
  await expect(page.getByText("This page needs a Finance or above.")).toBeVisible();
});

test("an Admin opens the section whose link has a trailing slash and a query", async ({ page }) => {
  await signInAs(page, "admin");
  await rail(page, "Admins").click();
  // Next drops the trailing slash; the page and its role are the same.
  await expect(page).toHaveURL(`${WEB}/x/admins/only?tab=week`);
  await expect(page.getByText("An extension page")).toBeVisible();
});
