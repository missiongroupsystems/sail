import { randomUUID } from "node:crypto";
import { expect, keyIn, SETUP_API, SETUP_WEB, signInToken, test } from "./fixtures";

/**
 * First run on an empty database (a second stack: `dev:local` with SAIL_DEV_EMPTY=1 and its own web app), through to
 * a paired POS sending an order to the kitchen. Nothing is seeded: everything the POS uses is created after setup.
 */
const ADMIN = { name: "Setup Admin", email: "setup.admin@first-run.test", password: "first run admin password" };
const PIN = "246802";

// The setup form suggests the region whose time zone is the device's: this device is in Singapore.
test.use({ viewport: { width: 1180, height: 820 }, timezoneId: "Asia/Singapore" });

test("first run: set up the business, sign in, pair the POS and send an order", async ({ page }) => {
  test.setTimeout(900_000);

  await test.step("an empty server opens on setup", async () => {
    await page.goto(`${SETUP_WEB}/today`);
    await page.waitForURL(`${SETUP_WEB}/setup`, { timeout: 300_000 });
    await expect(page.getByRole("heading", { name: "Set up Sail" })).toBeVisible();
  });

  await test.step("fill in the business, the first outlet and the first Admin", async () => {
    await expect(async () => {
      await page.getByLabel("Business name").fill("First Run Kitchen");
      await expect(page.getByLabel("Time zone")).toHaveValue("Asia/Singapore", { timeout: 5_000 });
    }).toPass({ timeout: 120_000 });
    await page.getByLabel("First outlet").fill("Main room");
    await page.getByLabel("Your name").fill(ADMIN.name);
    await page.getByLabel("Email").fill(ADMIN.email);
    await page.getByLabel("Password").fill(ADMIN.password);
    await page.getByRole("button", { name: "Set up and sign in" }).click();
    await page.waitForURL(`${SETUP_WEB}/today`, { timeout: 120_000 });
    await expect(page.getByRole("button", { name: /^Setup Admin, Admin/ })).toBeVisible();
    // A new business has nothing to sell yet: Today lists the steps to a first order, none of them done.
    await expect(page.getByRole("heading", { name: "Get ready for the first order" })).toBeVisible();
    await expect(page.getByText(/^0 of \d done$/)).toBeVisible();
  });

  let stationId = "";
  let code = "";
  await test.step("the Admin adds a dish, a table and a PIN, opens a shift, and issues a pairing code", async () => {
    const token = await signInToken(SETUP_API, ADMIN.email, ADMIN.password);
    const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const res = await fetch(`${SETUP_API}${path}`, { method, headers: { "content-type": "application/json", "idempotency-key": randomUUID(), authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
      const json = (await res.json()) as T;
      if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
      return json;
    };
    const me = await call<{ data: { id: string } }>("GET", "/v1/me");
    const [outlet] = (await call<{ data: { id: string }[] }>("GET", "/v1/outlets")).data;
    const [brand] = (await call<{ data: { id: string }[] }>("GET", "/v1/brands")).data;
    const [station] = (await call<{ data: { id: string }[] }>("GET", `/v1/outlets/${outlet!.id}/stations`)).data;
    stationId = station!.id;
    const product = randomUUID();
    const menu = randomUUID();
    const area = randomUUID();
    await call("PATCH", `/v1/staff/${me.data.id}`, { pin: PIN });
    await call("POST", "/v1/products", { id: product, name: "House noodles", price: 1200, tags: ["kitchen"] });
    await call("POST", "/v1/menus", { id: menu, brand_id: brand!.id, name: "All day", sections: [{ name: "Mains", items: [{ product_id: product }] }] });
    await call("POST", "/v1/channel-links", { channel: "pos", outlet_id: outlet!.id, brand_id: brand!.id, menu_id: menu });
    await call("POST", "/v1/areas", { id: area, outlet_id: outlet!.id, name: "Inside" });
    await call("POST", "/v1/tables", { outlet_id: outlet!.id, area_id: area, name: "1" });
    code = (await call<{ data: { code: string } }>("POST", `/v1/stations/${stationId}/pairing-code`, {})).data.code;
    // Cash is refused until a shift is open; the checklist says so until one has been.
    await call("POST", "/v1/shifts", { outlet_id: outlet!.id, station_id: null, float_cents: 0 });
  });

  await test.step("pair the iPad and sign in with the Admin's PIN", async () => {
    await page.goto(`${SETUP_WEB}/pos`);
    await expect(page.getByRole("heading", { name: "Pair this iPad to a station" })).toBeVisible({ timeout: 300_000 });
    await keyIn(page, "PIN keys", code);
    await page.getByRole("button", { name: "Pair this iPad" }).click();
    await expect(page.getByRole("button", { name: "Pair this iPad again" })).toBeVisible();
    await keyIn(page, "PIN keys", PIN);
    await expect(page.getByRole("navigation", { name: "Destinations" })).toBeVisible();
  });

  await test.step("seat the table, add the dish and send it", async () => {
    await page.getByRole("button", { name: "Floor", exact: true }).click();
    await page.getByRole("button", { name: /^Table 1, Free/ }).click();
    await page.getByRole("button", { name: "2 guests", exact: true }).click();
    await page.getByRole("button", { name: /^House noodles,/ }).click();
    await expect(page.getByRole("button", { name: "Send 1 to kitchen" })).toBeVisible();
    await page.getByRole("button", { name: "Send 1 to kitchen" }).click();
    await expect(page.getByRole("region", { name: "Order" }).getByText(/^Sent /)).toBeVisible();
  });

  await test.step("every step is done, so Today no longer shows the checklist", async () => {
    await page.goto(`${SETUP_WEB}/today`);
    await expect(page.getByRole("heading", { name: "Service", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Get ready for the first order" })).toHaveCount(0);
  });
});
