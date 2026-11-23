import type { Page } from "@playwright/test";
import { devLocal, expect, GUEST, pairAndSignIn, register, SG_ADMIN, test, WEB } from "./fixtures";

/**
 * The polish round before the first pilot outlet is set up: what the team hit in the walkthrough of 18 November.
 * Each test names the item it covers (A1 to A8 in the round's plan).
 */

const CASHIER_PIN = "333333"; // Cal Cashier (dev seed)

/** Orders this file opened through the API: cancelled after each test, so tables and lists are as the later specs expect. */
const opened: string[] = [];
test.afterEach(async () => {
  for (const orderId of opened.splice(0)) await register("POST", `/v1/orders/${orderId}/cancel`, { reason: "End-to-end test" }).catch(() => undefined);
});

/** Sign in to the back office as the seeded Admin; done once Today has rendered, so the next navigation is not cut short. */
async function signIn(page: Page) {
  await page.goto(`${WEB}/login`);
  await expect(async () => {
    await page.getByLabel("Email").fill(SG_ADMIN);
    await page.getByLabel("Password").fill(devLocal().admin_password);
    await page.getByRole("button", { name: "Sign in" }).click({ timeout: 10_000 });
    await page.waitForURL(`${WEB}/today`, { timeout: 30_000 });
  }).toPass({ timeout: 300_000 });
}

/** Open a row's sheet. A click before the dev server's first compile has hydrated the page does nothing: press until it opens. */
async function openRow(page: Page, name: string) {
  const sheet = page.getByRole("dialog", { name });
  await expect(async () => {
    await page.getByRole("rowheader", { name }).click({ timeout: 5_000 });
    await expect(sheet).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 120_000 });
  return sheet;
}

test.describe("POS", () => {
  test.use({ viewport: { width: 1180, height: 820 } });

  test("A1: an order opened on the floor is under Orders, with a type filter, and moves to Today's closed once paid", async ({ page }) => {
    test.setTimeout(420_000);
    const { outletId, brandId } = devLocal();
    await pairAndSignIn(page, CASHIER_PIN);

    let tableName = "";
    await test.step("open a dine-in order on the floor and send it", async () => {
      await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Floor", exact: true }).click();
      const free = page.getByRole("button", { name: /^Table \S+, Free/ }).first();
      tableName = ((await free.getAttribute("aria-label")) ?? "").match(/^Table (\S+),/)![1]!;
      await free.click();
      await page.getByRole("button", { name: "2 guests", exact: true }).click();
      await page.getByRole("button", { name: /^Mee Goreng,/ }).click();
      await page.getByRole("button", { name: "Send 1 to kitchen" }).click();
      await expect(page.getByRole("region", { name: "Order" }).getByText(/^Sent /)).toBeVisible();
    });

    await test.step("a takeaway and a pickup order from the API", async () => {
      for (const body of [
        { order_type: "takeaway", takeaway_ref: "Polish takeaway" },
        { order_type: "pickup", customer_ref: { name: "Polish pickup" } },
      ]) {
        const orderId = crypto.randomUUID();
        await register("POST", "/v1/orders", { order_id: orderId, outlet_id: outletId, brand_id: brandId, ...body });
        opened.push(orderId);
      }
    });

    const which = page.getByRole("group", { name: "Which orders" });
    const types = page.getByRole("group", { name: "Order type" });
    const rows = page.getByRole("button", { name: /^(Dine-in|Takeaway|Pickup|Delivery) \S+.*, (New|Sent|Ready|Out for delivery|Done|Cancelled)$/ });
    const dineIn = page.getByRole("button", { name: /^Dine-in / }).filter({ hasText: `Table ${tableName} · Dine-in` });

    await test.step("Orders → Open lists the table's order; All is chosen", async () => {
      await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Orders", exact: true }).click();
      await expect(types.getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");
      // The five types are always offered, Delivery too with no delivery order open.
      await expect(types.getByRole("button")).toHaveText([/^All/, /^Dine-in/, /^Takeaway/, /^Pickup/, /^Delivery/]);
      await expect(dineIn).toBeVisible();
      // Sent, but a table's order is not made ready from this list: Ready is for orders collected or delivered.
      await expect(page.getByRole("listitem").filter({ has: dineIn }).getByRole("button", { name: "Ready", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Takeaway / }).filter({ hasText: "Takeaway" }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: /^Pickup .*Polish pickup/ })).toBeVisible();
    });

    await test.step("each filter shows only its type", async () => {
      for (const [label, type] of [["Dine-in", "Dine-in"], ["Takeaway", "Takeaway"], ["Pickup", "Pickup"]] as const) {
        await types.getByRole("button", { name: new RegExp(`^${label}`) }).click();
        await expect(rows.first()).toBeVisible();
        const names = await rows.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""));
        expect(names.length, `${label}: rows`).toBeGreaterThan(0);
        for (const n of names) expect(n, `${label} filter`).toMatch(new RegExp(`^${type} `));
      }
      await types.getByRole("button", { name: /^Dine-in/ }).click();
      await expect(dineIn).toBeVisible();
      await expect(page.getByRole("button", { name: /^Pickup .*Polish pickup/ })).toHaveCount(0);
      await types.getByRole("button", { name: /^All/ }).click();
    });

    await test.step("pay the table by card: it leaves Open and is under Today's closed", async () => {
      await dineIn.click();
      await page.getByRole("button", { name: /^Pay \$/ }).click();
      await page.getByRole("group", { name: "Payment method" }).getByRole("button", { name: "Card", exact: true }).click();
      await page.getByRole("button", { name: /^Take .+ by Card$/ }).click();
      await expect(page.getByText(/^Paid · /)).toBeVisible();
      await page.getByRole("button", { name: "No receipt" }).click();
      await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Orders", exact: true }).click();
      await expect(which.getByRole("button", { name: /^Open/ })).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("button", { name: /^Pickup .*Polish pickup/ })).toBeVisible();
      await expect(dineIn).toHaveCount(0);
      await which.getByRole("button", { name: /^Today's closed/ }).click();
      await types.getByRole("button", { name: /^Dine-in/ }).click();
      await expect(page.getByRole("button", { name: /^Dine-in .*, Done$/ }).filter({ hasText: `Table ${tableName} · Dine-in` }).first()).toBeVisible();
    });
  });
});

test.describe("back office and POS together", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("A3: the product form marks what is required and says what Kind, Deposit item and Open price mean", async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page);
    await page.goto(`${WEB}/menu/products`);
    const sheet = page.getByRole("dialog", { name: "New product" });
    await expect(async () => {
      await page.getByRole("button", { name: "Add product" }).first().click({ timeout: 5_000 });
      await expect(sheet).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 120_000 });

    await test.step("Name and Base price carry the mark, and nothing else does", async () => {
      const marked = await sheet.locator("label:has([data-required-mark])").evaluateAll((els) => els.map((el) => el.textContent ?? ""));
      expect(marked).toEqual(["Name · Required", "Base price · Required"]);
      // The mark is for the eye; the control says "required" itself, and keeps its label as its name.
      await expect(sheet.getByRole("textbox", { name: "Name", exact: true })).toHaveAttribute("aria-required", "true");
      await expect(sheet.getByRole("textbox", { name: "Base price", exact: true })).toHaveAttribute("aria-required", "true");
    });

    await test.step("what a Component is shows where it is chosen, and the money hints stay on the form", async () => {
      // The Kind meaning lives in the option: the list says what a Component is; the closed field shows the choice only.
      await sheet.getByRole("button", { name: /Kind/ }).click();
      await expect(page.getByRole("option", { name: /Component/ })).toContainText("Used inside other items, not sold alone");
      await page.getByRole("option", { name: /Component/ }).click();
      await expect(sheet.getByRole("button", { name: /Kind/ })).toContainText("Component");
      await expect(sheet.getByText("Used inside other items, not sold alone")).toHaveCount(0);
      await sheet.getByRole("button", { name: /Kind/ }).click();
      await page.getByRole("option", { name: /^Product/ }).click();
      await expect(sheet.getByText("Adds the container deposit from Pricing.")).toBeVisible();
      await expect(sheet.getByText("Staff enter the price when they add the item.")).toBeVisible();
    });

    await test.step("saving with neither shows both messages and keeps the sheet", async () => {
      await sheet.getByRole("button", { name: "Add product" }).click();
      await expect(sheet.getByText("Enter a name")).toBeVisible();
      await expect(sheet.getByText("Enter a base price")).toBeVisible();
      await expect(sheet).toBeVisible();
    });
  });

  test("A4: Tenders is called Payment methods, and the old address still arrives", async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page);

    await test.step("the old address lands on the new one", async () => {
      await page.goto(`${WEB}/settings/tenders`);
      await page.waitForURL(`${WEB}/settings/payment-methods`);
      await expect(page).toHaveTitle(/Payment methods/);
      await expect(page.getByRole("grid", { name: "Payment methods" })).toBeVisible();
    });

    await test.step("the navigation and the page say Payment methods, never Tenders", async () => {
      await expect(page.getByRole("link", { name: "Payment methods", exact: true })).toHaveAttribute("href", "/settings/payment-methods");
      await expect(page.getByRole("link", { name: /Tender/i })).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText(/\bTenders?\b/i);
    });

    await test.step("the reports say it too", async () => {
      await page.goto(`${WEB}/reports`);
      await expect(page.locator("main")).toContainText("payment methods");
      await expect(page.locator("body")).not.toContainText(/\bTenders?\b/i);
      await page.goto(`${WEB}/reports/sales`);
      await expect(page.getByText("By payment method", { exact: true })).toBeVisible();
      await expect(page.locator("body")).not.toContainText(/\bTenders?\b/i);
    });
  });

  test("A5: a table's shape, seats and name apply as they are changed, with no Save; a new table lands on a free place", async ({ page, watch }) => {
    test.setTimeout(420_000);
    watch.allow({ status: 422, url: /\/v1\/tables\/[^/]+$/, why: "the refused-name step answers 422 itself, on purpose" });
    const { outletId } = devLocal();
    type T = { id: string; name: string; area_id: string; seats: number; shape: string; x: number; y: number; w: number; h: number; archived: boolean };
    const areaName = `Annex ${String(Date.now()).slice(-5)}`;
    // An area of its own, last on the POS floor, so the demo outlet's tables stay as the other specs expect them.
    const area = await register<{ data: { id: string } }>("POST", "/v1/areas", { outlet_id: outletId, name: areaName, sort: 60 });
    const inArea = async () => (await register<{ data: T[] }>("GET", `/v1/tables?outlet_id=${outletId}&area_id=${area.data.id}`)).data;
    // A crowded corner: a large table over four of the plan's usual places, and a table on the next one.
    await register("POST", "/v1/tables", { outlet_id: outletId, area_id: area.data.id, name: "Long", seats: 10, x: 0, y: 0, w: 5, h: 3 });
    await register("POST", "/v1/tables", { outlet_id: outletId, area_id: area.data.id, name: "Next", seats: 2, x: 6, y: 0, w: 2, h: 2 });

    try {
      await signIn(page);
      await page.goto(`${WEB}/floor`);
      const plan = page.getByRole("application", { name: `Floor plan for ${areaName}` });
      await expect(async () => {
        await page.getByRole("navigation", { name: "Areas" }).getByRole("button", { name: areaName, exact: true }).click({ timeout: 5_000 });
        await expect(plan).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 120_000 });
      const panel = page.locator("aside");

      let added: T;
      await test.step("Add table: the third table is on the visible grid, clear of the others, and selected", async () => {
        await page.getByRole("button", { name: "Add table" }).click();
        await expect.poll(async () => (await inArea()).length).toBe(3);
        const all = await inArea();
        added = all.find((t) => t.name !== "Long" && t.name !== "Next")!;
        expect(added.x + added.w, "inside the 24 columns").toBeLessThanOrEqual(24);
        expect(added.y + added.h, "inside the 14 rows").toBeLessThanOrEqual(14);
        for (const o of all.filter((t) => t.id !== added.id)) {
          const apart = added.x >= o.x + o.w || o.x >= added.x + added.w || added.y >= o.y + o.h || o.y >= added.y + added.h;
          expect(apart, `${added.name} at ${added.x},${added.y} is clear of ${o.name}`).toBe(true);
        }
        await expect(plan.getByRole("button", { name: new RegExp(`^${added.name}, 4 seats, rect`) })).toHaveAttribute("aria-pressed", "true");
        await expect(panel.getByRole("textbox", { name: "Name" })).toHaveValue(added.name);
        await expect(panel.getByRole("button", { name: "Save table" })).toHaveCount(0);
        await expect(panel.getByText("Changes save as you make them.")).toBeVisible();
      });

      await test.step("shape applies when chosen; seats when the field is left; a name after a pause in typing", async () => {
        await panel.getByRole("button", { name: /Shape/ }).click();
        await page.getByRole("option", { name: "Round" }).click();
        await expect(plan.getByRole("button", { name: `${added.name}, 4 seats, round` })).toBeVisible();
        await expect.poll(async () => (await inArea()).find((t) => t.id === added.id)!.shape).toBe("round");
        // The first change that goes through says Saved.
        await expect(panel.getByText("Saved", { exact: true })).toBeVisible();

        await panel.getByRole("textbox", { name: "Seats" }).fill("6");
        await panel.getByRole("textbox", { name: "Seats" }).blur();
        await expect(plan.getByRole("button", { name: `${added.name}, 6 seats, round` })).toBeVisible();

        // No blur and no Enter: the name goes once the typing stops.
        await panel.getByRole("textbox", { name: "Name" }).fill("Window");
        await expect(plan.getByRole("button", { name: "Window, 6 seats, round" })).toBeVisible();
        await expect(panel.getByRole("heading", { name: "Window" })).toBeVisible();
        await expect.poll(async () => (await inArea()).find((t) => t.id === added.id)).toMatchObject({ name: "Window", seats: 6, shape: "round" });
      });

      await test.step("a refused name stays on show after another change saves, and changes are sent one at a time", async () => {
        // The register refuses the name "Refused" (as it would a name it cannot take) and takes everything else. The later
        // change is a shape, sent on its own, and it goes through: once, that save wiped the refusal while the panel
        // still showed the refused name. Leaving the name field to pick the shape sends the name again, refused again.
        let inFlight = 0;
        let overlapped = false;
        await page.route(new RegExp(`/v1/tables/${added.id}$`), async (route) => {
          if (route.request().method() !== "PATCH") return route.continue();
          inFlight++;
          if (inFlight > 1) overlapped = true;
          try {
            if ((route.request().postDataJSON() as { name?: string }).name === "Refused") return await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ code: "validation_failed", message: "That name is refused", remedy: "Choose another name." }) });
            await new Promise((r) => setTimeout(r, 300));
            return await route.continue();
          } finally {
            inFlight--;
          }
        });
        const refusal = panel.getByText("That name is refused Choose another name.");
        await panel.getByRole("textbox", { name: "Name" }).fill("Refused");
        await expect(refusal).toBeVisible();

        await panel.getByRole("button", { name: /Shape/ }).click();
        await page.getByRole("option", { name: "Square" }).click();
        await expect.poll(async () => (await inArea()).find((t) => t.id === added.id)!.shape).toBe("square");
        // Settled, not saving: the panel still says the name is not saved, and why.
        await expect(panel.getByText("Not saved yet.")).toBeVisible();
        await expect(refusal).toBeVisible();
        await expect(panel.getByRole("textbox", { name: "Name" })).toHaveValue("Refused");
        expect((await inArea()).find((t) => t.id === added.id)).toMatchObject({ name: "Window", shape: "square" });

        // Back to the saved name: nothing is left unsaved, so the refusal goes.
        await panel.getByRole("textbox", { name: "Name" }).fill("Window");
        await expect(refusal).toHaveCount(0);
        await expect(panel.getByText("Saved", { exact: true })).toBeVisible();

        // Two quick changes: sent one after the other, and the last one stays.
        await panel.getByRole("textbox", { name: "Seats" }).fill("7");
        await panel.getByRole("textbox", { name: "Seats" }).blur();
        await panel.getByRole("textbox", { name: "Seats" }).fill("6");
        await panel.getByRole("textbox", { name: "Seats" }).blur();
        await expect.poll(async () => (await inArea()).find((t) => t.id === added.id)!.seats).toBe(6);
        await page.waitForTimeout(1_000);
        expect((await inArea()).find((t) => t.id === added.id)!.seats).toBe(6);
        expect(overlapped, "no two saves of the table were in flight at once").toBe(false);
        await page.unrouteAll({ behavior: "ignoreErrors" });

        // The shape goes back to round, as the later steps expect.
        await panel.getByRole("button", { name: /Shape/ }).click();
        await page.getByRole("option", { name: "Round" }).click();
        await expect.poll(async () => (await inArea()).find((t) => t.id === added.id)!.shape).toBe("round");
      });

      await test.step("a value that cannot be used says so under its field and is not sent", async () => {
        await panel.getByRole("textbox", { name: "Name" }).fill("");
        await expect(panel.getByText("Enter a name")).toBeVisible();
        await panel.getByRole("textbox", { name: "Seats" }).fill("150");
        await expect(panel.getByText("From 1 to 99 seats")).toBeVisible();
        await panel.getByRole("textbox", { name: "Seats" }).blur();
        // Longer than the typing pause: nothing went to the register.
        await page.waitForTimeout(1_200);
        expect((await inArea()).find((t) => t.id === added.id)).toMatchObject({ name: "Window", seats: 6 });
        await expect(plan.getByRole("button", { name: "Window, 6 seats, round" })).toBeVisible();
      });

      await test.step("the changes are there after a reload", async () => {
        await page.reload();
        await expect(async () => {
          await page.getByRole("navigation", { name: "Areas" }).getByRole("button", { name: areaName, exact: true }).click({ timeout: 5_000 });
          await expect(plan.getByRole("button", { name: "Window, 6 seats, round" })).toBeVisible({ timeout: 5_000 });
        }).toPass({ timeout: 120_000 });
      });
    } finally {
      for (const t of await inArea()) await register("PATCH", `/v1/tables/${t.id}`, { archived: true });
    }
  });

  test("A6: pairing an iPad: the code survives the sheet closing, pastes with spaces, the sheet says Paired by itself, and a replaced code says so", async ({ page, browser, watch }) => {
    test.setTimeout(480_000);
    const { outletId, brandId } = devLocal();
    const name = `Pairing ${String(Date.now()).slice(-6)}`;
    const station = await register<{ data: { id: string } }>("POST", "/v1/stations", { name, kind: "pos", outlet_id: outletId, brand_id: brandId });
    const pairingCodes = /\/v1\/stations\/[^/]+\/pairing-code$/;
    const ipad = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    watch.attach(ipad);
    // The code as the back office shows it: one label with its six digits.
    const shownCode = async (sheet: import("@playwright/test").Locator) => ((await sheet.getByLabel(/^Pairing code \d/).getAttribute("aria-label")) ?? "").replace(/\D/g, "");

    try {
      await signIn(page);
      await page.goto(`${WEB}/settings/stations`);
      let sheet = await openRow(page, name);
      let code = "";

      await test.step("Pair an iPad shows the code, its countdown and that it is waiting", async () => {
        await sheet.getByRole("button", { name: "Pair an iPad" }).click();
        code = await shownCode(sheet);
        expect(code).toMatch(/^\d{6}$/);
        await expect(sheet.getByText(/Expires at .+ · \d+:\d\d left · one use only/)).toBeVisible();
        await expect(sheet.getByRole("status").filter({ hasText: "Waiting for the iPad…" })).toBeVisible();
        await expect(sheet.getByRole("button", { name: "Replace code" })).toBeVisible();
        await expect(sheet.getByText("The code above stops working.")).toBeVisible();
      });

      await test.step("closing the sheet and opening it again shows the same code and asks the register for no other", async () => {
        let asked = 0;
        const count = (r: import("@playwright/test").Request) => {
          if (r.method() === "POST" && pairingCodes.test(r.url())) asked++;
        };
        page.on("request", count);
        await sheet.getByRole("button", { name: "Cancel" }).click();
        await expect(sheet).toBeHidden();
        sheet = await openRow(page, name);
        await expect(sheet.getByRole("status").filter({ hasText: "Waiting for the iPad…" })).toBeVisible();
        expect(await shownCode(sheet)).toBe(code);
        page.off("request", count);
        expect(asked, "pairing codes asked for on reopening").toBe(0);
      });

      await test.step("the iPad's pairing screen is not the PIN pad", async () => {
        await ipad.goto(`${WEB}/pos`);
        await expect(ipad.getByRole("heading", { name: "Pair this iPad to a station" })).toBeVisible({ timeout: 180_000 });
        await expect(ipad.getByRole("textbox", { name: "Pairing code from the back office" })).toBeVisible();
        await expect(ipad.getByRole("group", { name: "PIN keys" })).toHaveCount(0);
      });

      await test.step("a wrong code says Wrong code", async () => {
        watch.allow({ status: 401, url: /\/v1\/stations\/pair$/, why: "a wrong pairing code, then a replaced one, on purpose" });
        const wrong = ["135790", "246801"].find((c) => c !== code)!;
        await ipad.getByRole("textbox", { name: "Pairing code from the back office" }).fill(wrong);
        await ipad.keyboard.press("Enter");
        await expect(ipad.getByRole("alert").filter({ hasText: "Wrong code." })).toBeVisible();
        await expect(ipad.getByRole("alert").filter({ hasText: /expired|replaced/ })).toHaveCount(0);
      });

      await test.step("the code pasted with a space waits for the iPad's name, then pairs on the button; the sheet says Paired by itself", async () => {
        const field = ipad.getByRole("textbox", { name: "Pairing code from the back office" });
        await field.fill("");
        await field.focus();
        const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
        await ipad.evaluate((text) => {
          const data = new DataTransfer();
          data.setData("text/plain", text);
          document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        }, spaced);
        await expect(field).toHaveValue(code);
        // Six digits do not pair by themselves: the iPad is named first.
        await ipad.waitForTimeout(1_000);
        await expect(ipad.getByRole("heading", { name: "Pair this iPad to a station" })).toBeVisible();
        await ipad.getByRole("textbox", { name: "Name for this iPad" }).fill("Bar iPad");
        await ipad.getByRole("button", { name: "Pair this iPad", exact: true }).click();
        await expect(ipad.getByRole("button", { name: "Pair this iPad again" })).toBeVisible();
        await expect(ipad.getByRole("group", { name: "PIN keys" })).toBeVisible();

        await expect(sheet.getByRole("status").filter({ hasText: "Paired: Bar iPad" })).toBeVisible({ timeout: 20_000 });
        // The subtitle follows: Paired, once, with the device's name.
        await expect(sheet.getByText("Paired · Bar iPad", { exact: true })).toHaveCount(1);
        await expect(sheet.getByText(/Not paired/)).toHaveCount(0);
        await expect(sheet.getByLabel(/^Pairing code \d/)).toHaveCount(0);
        await expect(sheet.getByText("Waiting for the iPad…")).toHaveCount(0);
      });

      await test.step("after a reload the sheet does not replace a live code unasked: it says one is out, and offers Replace code", async () => {
        // A code issued elsewhere (here, through the API): this browser was never shown it.
        const first = (await register<{ data: { code: string } }>("POST", `/v1/stations/${station.data.id}/pairing-code`, {})).data.code;
        await page.reload();
        sheet = await openRow(page, name);
        watch.allow({ status: 409, url: pairingCodes, why: "the register refuses to replace a live code unasked; the sheet turns that into a choice" });
        await sheet.getByRole("button", { name: "Pair another iPad" }).click();
        await expect(sheet.getByText(/A code was issued at .+ and expires at .+ A code is shown once, so it cannot be shown again here\./)).toBeVisible();
        await expect(sheet.getByText("The old code stops working.")).toBeVisible();
        await expect(sheet.getByLabel(/^Pairing code \d/)).toHaveCount(0);

        await sheet.getByRole("button", { name: "Replace code" }).click();
        const second = await shownCode(sheet);
        expect(second).toMatch(/^\d{6}$/);

        // The replaced code on an iPad: its own message, not "Wrong code".
        if (first !== second) {
          const other = await browser.newPage({ viewport: { width: 1180, height: 820 } });
          watch.attach(other);
          await other.goto(`${WEB}/pos`);
          await other.getByRole("textbox", { name: "Pairing code from the back office" }).fill(first);
          await other.keyboard.press("Enter");
          await expect(other.getByRole("alert").filter({ hasText: "This code has expired or was replaced. Get a new one in the back office" })).toBeVisible();
          await other.close();
        }
      });
    } finally {
      await ipad.close();
      await register("PATCH", `/v1/stations/${station.data.id}`, { archived: true });
    }
  });

  test("A7: a table code at an outlet with Scan to order off tells the guest and the staff; once it is on, the same code orders", async ({ page, browser, watch }) => {
    test.setTimeout(420_000);
    const { outletId, brandId } = devLocal();
    const links = await register<{ data: { id: string; outlet_id: string; enabled: boolean }[] }>("GET", `/v1/channel-links?channel=scan_to_order&outlet_id=${outletId}`);
    const link = links.data.find((l) => l.outlet_id === outletId && l.enabled);
    if (!link) throw new Error("The demo outlet has no Scan to order channel switched on");
    const setLink = (enabled: boolean) => register("PATCH", `/v1/channel-links/${link.id}`, { enabled });

    // A seated table and the code printed for it.
    const floor = await register<{ data: { tables: { id: string; name: string; order: unknown }[] } }>("GET", `/v1/outlets/${outletId}/floor`);
    const table = floor.data.tables.find((t) => !t.order);
    if (!table) throw new Error("No free table left in the demo outlet");
    const orderId = crypto.randomUUID();
    await register("POST", "/v1/orders", { order_id: orderId, order_type: "dine_in", table_id: table.id, pax: 2, outlet_id: outletId, brand_id: brandId });
    opened.push(orderId);
    const url = (await register<{ data: { url: string } }>("POST", `/v1/tables/${table.id}/qr/rotate`, {})).data.url;
    const address = `${GUEST}/t/${url.split("/t/")[1]!}`;

    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    watch.attach(phone);
    try {
      // The outlet as it was in the walkthrough: tables and printed codes, and no Scan to order channel taking orders.
      await setLink(false);

      await test.step("the guest is told in plain words, with no blank page and no error code", async () => {
        watch.allow({ status: 422, url: /\/v1\/guest\/sessions$/, why: "the register refuses a session while Scan to order is off; the page says so" });
        await phone.goto(address);
        await expect(phone.getByText("This table isn't taking orders on the phone yet")).toBeVisible({ timeout: 180_000 });
        await expect(phone.getByText("Please ask the staff.")).toBeVisible();
        await expect(phone.locator("body")).not.toContainText(/unavailable|422|scan_to_order/);
        await expect(phone.getByRole("button", { name: /^Laksa,/ })).toHaveCount(0);
      });

      await test.step("Floor & QR says the codes take no orders yet, by the plan and by the QR sheet, and points to Settings › Channels", async () => {
        await signIn(page);
        await page.goto(`${WEB}/floor`);
        const note = page.getByRole("alert").filter({ hasText: "do not take orders yet" });
        await expect(note).toContainText("the outlet has no Scan to order channel switched on");
        await expect(note.getByRole("link", { name: "Set it up in Settings › Channels" })).toHaveAttribute("href", "/settings/channels");
        // Said once, in the note: the QR sheet button is described by it rather than repeating it in red.
        await expect(page.getByText("These codes do not take orders yet: see the note below.")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Download QR sheet (PDF)" })).toHaveAccessibleDescription(/do not take orders yet/);
      });

      await setLink(true);

      await test.step("with the channel on, the same code opens the menu and the guest orders", async () => {
        await phone.goto(address);
        await phone.getByRole("button", { name: /^Kopi,/ }).click();
        await phone.getByRole("dialog", { name: "Kopi" }).getByRole("button", { name: /^Add to order/ }).click();
        await phone.getByRole("button", { name: /^View your order, 1 item/ }).click();
        await phone.getByRole("button", { name: /^Send/ }).first().click();
        await expect(phone.getByRole("heading", { name: "Order sent" })).toBeVisible();
      });

      await test.step("and Floor & QR has no warning any more", async () => {
        await page.reload();
        await expect(page.getByRole("application", { name: /Floor plan/ })).toBeVisible();
        await expect(page.getByRole("alert").filter({ hasText: "do not take orders yet" })).toHaveCount(0);
        await expect(page.getByText("These codes do not take orders yet: see the note below.")).toHaveCount(0);
      });
    } finally {
      await setLink(true);
      await phone.close();
    }
  });

  // A2 as run B changed it: a station no longer has a brand of its own to choose or to lack. The outlet belongs to
  // one brand and its stations are on it, so the "no brand" state A2 handled cannot be made any more (the register
  // and the database give a station its outlet's brand). The server tests in station-brand.test.ts cover the refusals.
  test("A2: a station is on its outlet's brand, shown and not chosen, for a POS station and a kitchen display", async ({ page }) => {
    test.setTimeout(420_000);
    const { outletId, brandId } = devLocal();
    const stamp = String(Date.now()).slice(-6);
    const till = `Brand till ${stamp}`;
    const display = `Pass screen ${stamp}`;
    const brands = await register<{ data: { id: string; name: string }[] }>("GET", "/v1/brands");
    const brandName = brands.data.find((b) => b.id === brandId)!.name;
    // Created with no brand named: it takes the outlet's.
    const made = await register<{ data: { id: string; brand_id: string | null } }>("POST", "/v1/stations", { name: till, kind: "pos", outlet_id: outletId });
    expect(made.data.brand_id).toBe(brandId);

    try {
      await signIn(page);
      await page.goto(`${WEB}/settings/stations`);

      await test.step("the station's sheet shows the outlet's brand, read only, with no brand to choose", async () => {
        await expect(page.getByRole("row", { name: new RegExp(till) })).toContainText(brandName);
        const sheet = await openRow(page, till);
        const brand = sheet.getByRole("textbox", { name: "Brand" });
        await expect(brand).toHaveValue(brandName);
        await expect(brand).toHaveAttribute("readonly", "");
        await expect(sheet.getByText("The outlet's brand.", { exact: false })).toBeVisible();
        await expect(sheet.getByRole("button", { name: /Brand/ })).toHaveCount(0);
        await sheet.getByRole("button", { name: "Cancel" }).click();
        await expect(sheet).toBeHidden();
      });

      await test.step("a new kitchen display saves, on the outlet's brand like every station", async () => {
        // The closing sheet keeps its own Add station for a moment; the page's button comes first.
        await page.getByRole("button", { name: "Add station" }).first().click();
        const sheet = page.getByRole("dialog", { name: "New station" });
        await sheet.getByLabel("Name").fill(display);
        await sheet.getByRole("button", { name: /Kind/ }).click();
        await page.getByRole("option", { name: /Kitchen display/ }).click();
        await sheet.getByRole("button", { name: "Add station" }).click();
        await expect(sheet).toBeHidden();
        await expect(page.getByRole("row", { name: new RegExp(display) })).toContainText("Kitchen display");
        const all = await register<{ data: { name: string; brand_id: string | null }[] }>("GET", `/v1/outlets/${outletId}/stations`);
        expect(all.data.find((s) => s.name === display)?.brand_id).toBe(brandId);
      });
    } finally {
      const all = await register<{ data: { id: string; name: string }[] }>("GET", `/v1/outlets/${outletId}/stations`);
      for (const s of all.data.filter((x) => x.name === till || x.name === display)) await register("PATCH", `/v1/stations/${s.id}`, { archived: true });
    }
  });
});
