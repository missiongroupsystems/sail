import type { Page } from "@playwright/test";
import { API, expect, pairAndSignIn, test } from "./fixtures";

/**
 * PIN sessions: the register keeps one alive only while a person acts on it, and every lock ends it there too, so a
 * token left behind opens nothing. A session that ends on the register shows the PIN pad, never an error.
 */

const CASHIER_PIN = "333333";

test.use({ viewport: { width: 1180, height: 820 } });

/** The signed-in PIN session token, as the station keeps it (sessionStorage). */
async function pinToken(page: Page): Promise<string> {
  const token = await page.evaluate(() => (JSON.parse(sessionStorage.getItem("sail.pos.session") ?? "{}") as { state?: { token?: string } }).state?.token ?? null);
  expect(token, "a PIN session token").toBeTruthy();
  return token!;
}

/** What the register says to a read with this token: 200 while the session lives, 401 once it has ended. */
const meStatus = async (token: string) => (await fetch(`${API}/v1/me`, { headers: { authorization: `Bearer ${token}` } })).status;

test("Lock shows the PIN pad and ends the session on the register", async ({ page }) => {
  test.setTimeout(300_000);
  await pairAndSignIn(page, CASHIER_PIN);
  const token = await pinToken(page);
  expect(await meStatus(token)).toBe(200);
  await page.getByRole("banner").getByRole("button", { name: "Lock", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pair this iPad again" })).toBeVisible();
  await expect.poll(() => meStatus(token), { message: "the old token opens nothing" }).toBe(401);
});

test("a session ended on the register shows the PIN pad, not an error, and nothing carries over to the next sign-in", async ({ page, watch }) => {
  test.setTimeout(300_000);
  watch.allow({ status: 401, url: /\/v1\//, why: "the session was ended on the register on purpose; the station answers by locking" });
  await pairAndSignIn(page, CASHIER_PIN);
  const token = await pinToken(page);
  const ended = await fetch(`${API}/v1/stations/sessions/end`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "idempotency-key": crypto.randomUUID() }, body: "{}" });
  expect(ended.ok, "ending the session from outside the station").toBe(true);
  // Any request now meets a 401 and locks the station: a background read may get there before the tap does.
  await page.getByRole("button", { name: "Takeaway order", exact: true }).click({ timeout: 3_000 }).catch(() => undefined);
  await expect(page.getByRole("button", { name: "Pair this iPad again" })).toBeVisible();
  await expect(page.getByText("Your session ended. Sign in again.")).toBeVisible();
  // No error notice: the register's "session has ended" is answered by the PIN pad alone.
  await expect(page.getByText(/PIN session has ended/)).toHaveCount(0);
  const pad = page.getByRole("group", { name: "PIN keys" });
  for (const d of CASHIER_PIN) await pad.getByRole("button", { name: d, exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Destinations" })).toBeVisible();
  await expect(page.getByText(/PIN session has ended/)).toHaveCount(0);
});

test("the inactivity lock ends the session on the register too", async ({ page }) => {
  test.setTimeout(300_000);
  await pairAndSignIn(page, CASHIER_PIN);
  const token = await pinToken(page);
  // A short timeout for the test: the station's timer follows the person's own input, not the register's clock.
  await page.evaluate(() => {
    const saved = JSON.parse(sessionStorage.getItem("sail.pos.session") ?? "{}") as { state: { expiresInSeconds: number } };
    saved.state.expiresInSeconds = 12;
    sessionStorage.setItem("sail.pos.session", JSON.stringify(saved));
  });
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Destinations" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pair this iPad again" })).toBeVisible({ timeout: 40_000 });
  await expect(page.getByText("Locked after inactivity. Sign in to continue.")).toBeVisible();
  await expect.poll(() => meStatus(token), { message: "the idle session is ended, not left to expire" }).toBe(401);
});
