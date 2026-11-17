import { devLocal, expect, GUEST, keyIn, pairAndSignIn, register, test, WEB } from "./fixtures";

/** Final review, front of house: the guest's phone, the POS floor and order screens, the kitchen display. */

async function seatedTableToken(): Promise<{ token: string; tableId: string; tableName: string }> {
  const { outletId, brandId } = devLocal();
  const floor = await register<{ data: { tables: { id: string; name: string; order: unknown }[] } }>("GET", `/v1/outlets/${outletId}/floor`);
  const table = floor.data.tables.find((t) => !t.order);
  if (!table) throw new Error("No free table left in the demo outlet");
  await register("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "dine_in", table_id: table.id, pax: 2, outlet_id: outletId, brand_id: brandId });
  const qr = await register<{ data: { url: string } }>("POST", `/v1/tables/${table.id}/qr/rotate`, {});
  return { token: qr.data.url.split("/t/")[1]!, tableId: table.id, tableName: table.name };
}

test("guest: the register's totals before sending, and the tax note from the first scan (C-6, C-7)", async ({ browser, watch }) => {
  test.setTimeout(240_000);
  const { token } = await seatedTableToken();
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  watch.attach(phone);
  await phone.goto(`${GUEST}/t/${token}`);

  await test.step("the price note says the GST is added, before anything is ordered", async () => {
    await expect(phone.getByText("GST is added to your bill, with any service charge.")).toBeVisible();
  });

  await test.step("the item sheet carries the line's total: Laksa with prawn, two of them", async () => {
    await phone.getByRole("button", { name: /^Laksa,/ }).click();
    const sheet = phone.getByRole("dialog", { name: "Laksa" });
    await expect(sheet.getByRole("button", { name: "Add to order · $18.00" })).toBeVisible();
    await sheet.getByRole("button", { name: "More quantity" }).click();
    await expect(sheet.getByRole("button", { name: "Add 2 to order · $36.00" })).toBeVisible();
    await sheet.getByRole("button", { name: /^Add 2 to order/ }).click();
    await expect(sheet).toBeHidden();
    await phone.getByRole("button", { name: /^Kopi,/ }).click();
    await phone.getByRole("dialog", { name: "Kopi" }).getByRole("button", { name: "Add to order · $1.80" }).click();
  });

  await test.step("the cart bar and the review show the register's total; the review each line's amount", async () => {
    const bar = phone.getByRole("button", { name: "View your order, 3 items, $37.80" });
    await expect(bar).toBeVisible();
    await bar.click();
    const items = phone.getByRole("list", { name: "Your items" });
    await expect(items.getByRole("listitem").filter({ hasText: "Laksa" }).first()).toContainText("$36.00");
    await expect(items.getByRole("listitem").filter({ hasText: "Kopi" }).first()).toContainText("$1.80");
    await expect(phone.getByText("Subtotal", { exact: true })).toBeVisible();
    await expect(phone.locator("main")).toContainText("$37.80");
    await expect(phone.getByText("GST is added to your bill, with any service charge.")).toBeVisible();
  });

  await test.step("after sending, the table shows the same amounts for those lines", async () => {
    await phone.getByRole("button", { name: /^Send 3 items/ }).click();
    await expect(phone.getByRole("heading", { name: "Order sent" })).toBeVisible();
    await phone.getByRole("button", { name: /^Our table/ }).click();
    const round = phone.getByRole("region", { name: /^Order sent / });
    await expect(round).toContainText("$36.00");
    await expect(round).toContainText("$1.80");
  });
});

test("guest: browser Back closes an open sheet and nothing else (C-10)", async ({ browser, watch }) => {
  test.setTimeout(180_000);
  const { token } = await seatedTableToken();
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  watch.attach(phone);
  await phone.goto(`${GUEST}/t/${token}`);
  const menuUrl = phone.url();

  await test.step("on the menu: the item sheet closes, the menu stays", async () => {
    await phone.getByRole("button", { name: /^Kopi,/ }).click();
    const sheet = phone.getByRole("dialog", { name: "Kopi" });
    await expect(sheet).toBeVisible();
    await phone.goBack();
    await expect(sheet).toBeHidden();
    await expect(phone.getByRole("button", { name: /^Kopi,/ })).toBeVisible();
    expect(phone.url()).toBe(menuUrl);
  });

  await test.step("a sheet closed by its own button leaves Back where it was", async () => {
    await phone.getByRole("button", { name: /^Kopi,/ }).click();
    await phone.getByRole("dialog", { name: "Kopi" }).getByRole("button", { name: /^Add to order/ }).click();
    await expect(phone.getByRole("dialog", { name: "Kopi" })).toBeHidden();
    await phone.getByRole("button", { name: /^View your order/ }).click();
    await expect(phone.getByRole("heading", { name: "Your order" })).toBeVisible();
    // On the review, changing an item opens its sheet; Back closes it and stays on the review.
    await phone.getByRole("button", { name: "Edit Kopi" }).click();
    await expect(phone.getByRole("dialog", { name: "Kopi" })).toBeVisible();
    await phone.goBack();
    await expect(phone.getByRole("dialog", { name: "Kopi" })).toBeHidden();
    await expect(phone.getByRole("heading", { name: "Your order" })).toBeVisible();
    // Back again leaves the review for the menu, as before.
    await phone.goBack();
    await expect(phone.getByRole("button", { name: /^Kopi,/ })).toBeVisible();
  });

  await test.step("the Call staff sheet closes on Back too", async () => {
    await phone.getByRole("button", { name: /^Call staff/ }).first().click();
    const sheet = phone.getByRole("dialog", { name: "Call staff" });
    await expect(sheet).toBeVisible();
    await phone.goBack();
    await expect(sheet).toBeHidden();
    await expect(phone.getByRole("button", { name: /^Kopi,/ })).toBeVisible();
  });
});

test("guest: sticky bars are opaque on the page background, so scrolled text never shows through (C-12)", async ({ browser, watch }) => {
  test.setTimeout(180_000);
  const { token } = await seatedTableToken();
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  watch.attach(phone);
  await phone.goto(`${GUEST}/t/${token}`);
  await expect(phone.getByRole("button", { name: /^Kopi,/ })).toBeVisible();
  const opaque = async (selector: string) => {
    const s = await phone.locator(selector).first().evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, filter: cs.backdropFilter, page: getComputedStyle(document.querySelector("div.min-h-dvh") ?? document.body).backgroundColor };
    });
    expect(s.bg, selector).toBe(s.page);
    expect(s.bg, selector).not.toMatch(/rgba\(.*,\s*0?\.\d+\)|\/\s*0?\.\d+\)/);
    expect(["none", ""], selector).toContain(s.filter);
  };
  await opaque("div.sticky");
  await phone.getByRole("button", { name: /^Kopi,/ }).click();
  await phone.getByRole("dialog", { name: "Kopi" }).getByRole("button", { name: /^Add to order/ }).click();
  await opaque("div.fixed.bottom-0 > div");
  await phone.getByRole("button", { name: /^View your order/ }).click();
  await opaque("header.sticky");
});

test("POS: a customer is added from the order's Customer sheet and attached (B-P9); a pickup order offers no Move table (B-P15)", async ({ page, watch }) => {
  test.setTimeout(240_000);
  await pairAndSignIn(page, "333333"); // Cal Cashier may add customers
  const mobile = `+6591${String(Date.now()).slice(-6)}`;
  await page.getByRole("button", { name: "Floor", exact: true }).click();
  await page.getByRole("button", { name: /^Table \d+, Free/ }).first().click();
  await page.getByRole("button", { name: "2 guests", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Menu sections" })).toBeVisible();

  await page.getByRole("button", { name: "Order", exact: true }).click();
  await page.getByRole("menuitem", { name: "Customer" }).click();
  const sheet = page.getByRole("dialog", { name: "Customer" });
  await sheet.getByLabel("Mobile number").fill(mobile);
  await expect(sheet.getByText("No customer with that number.")).toBeVisible();
  await expect(sheet.getByText(/back office/)).toHaveCount(0);
  await sheet.getByRole("button", { name: "Add customer" }).click();
  await sheet.getByLabel("Name").fill("Final Front Guest");
  await sheet.getByRole("button", { name: "Add customer" }).click();
  await expect(sheet).toBeHidden();
  const found = await register<{ data: { id: string; name: string }[] }>("GET", `/v1/customers?mobile=${encodeURIComponent(mobile)}`);
  expect(found.data.map((c) => c.name)).toEqual(["Final Front Guest"]);

  await page.getByRole("button", { name: "Order", exact: true }).click();
  await page.getByRole("menuitem", { name: "Customer" }).click();
  await expect(page.getByRole("dialog", { name: "Customer" }).getByText("Final Front Guest")).toBeVisible();
  await page.keyboard.press("Escape");

  await test.step("as a pickup the order menu has no Move table", async () => {
    await page.getByRole("button", { name: "Order", exact: true }).click();
    await page.getByRole("menuitem", { name: "Change type" }).click();
    const type = page.getByRole("dialog", { name: "Change type" });
    await type.getByRole("button", { name: "Pickup" }).click();
    await type.getByLabel("Customer name").fill("Final Front Guest");
    await type.getByRole("button", { name: "Change to Pickup" }).click();
    await expect(type).toBeHidden();
    await page.getByRole("button", { name: "Order", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Customer" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Move table" })).toHaveCount(0);
    await page.keyboard.press("Escape");
  });
});

test("kitchen display: with 12 tickets and a 10-line one, every ticket and its Bump is reachable at 1280x800 and 1024x768 (B-P10)", async ({ browser, watch }) => {
  test.setTimeout(300_000);
  const { outletId, brandId } = devLocal();
  const stations = await register<{ data: { id: string; kind: string }[] }>("GET", `/v1/outlets/${outletId}/stations`);
  const display = stations.data.find((s) => s.kind === "display")!;
  const products = await register<{ data: { id: string; name: string }[] }>("GET", "/v1/products?limit=100");
  const pid = (name: string) => products.data.find((p) => p.name === name)!.id;
  const dishes = ["Mee Goreng", "Char Kway Teow"].map(pid);
  const ticket = async (ref: string, lines: { product_id: string; notes?: string }[]) => {
    const o = await register<{ data: { id: string } }>("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "takeaway", takeaway_ref: ref, outlet_id: outletId, brand_id: brandId });
    await register("POST", `/v1/orders/${o.data.id}/lines`, { lines: lines.map((l) => ({ line_id: crypto.randomUUID(), quantity: 1, ...l })) });
    await register("POST", `/v1/orders/${o.data.id}/fire`, {});
  };
  for (let i = 1; i <= 11; i++) await ticket(`KDS ${i}`, [{ product_id: dishes[i % 2]! }, { product_id: dishes[(i + 1) % 2]! }]);
  await ticket("KDS long", Array.from({ length: 10 }, (_, i) => ({ product_id: dishes[i % 2]!, notes: `Line ${i + 1} note` })));

  for (const viewport of [{ width: 1280, height: 800 }, { width: 1024, height: 768 }]) {
    await test.step(`at ${viewport.width}x${viewport.height}`, async () => {
      const ctx = await browser.newContext({ viewport });
      const kds = await ctx.newPage();
      watch.attach(kds);
      const { data } = await register<{ data: { code: string } }>("POST", `/v1/stations/${display.id}/pairing-code`, {});
      await kds.goto(`${WEB}/kds`);
      await expect(kds.getByRole("heading", { name: "Pair this screen to a station" })).toBeVisible({ timeout: 180_000 });
      await keyIn(kds, "PIN keys", data.code);
      await kds.getByRole("button", { name: "Pair this screen" }).click();
      const board = kds.getByRole("region", { name: "Tickets" });
      await expect(board.getByRole("button", { name: /KDS long/ })).toBeAttached();
      const cards = board.locator("[data-ticket]");
      const total = await cards.count();
      expect(total).toBeGreaterThanOrEqual(12);
      // Which cards are wholly on screen, with their Bump pill.
      const inView = async () =>
        board.evaluate((el) => {
          const box = el.getBoundingClientRect();
          const vh = window.innerHeight;
          return Array.from(el.querySelectorAll<HTMLElement>("[data-ticket]")).filter((c) => {
            const r = c.getBoundingClientRect();
            return r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= 0 && r.bottom <= vh + 1;
          }).map((c) => c.getAttribute("aria-label")!);
        });
      const seen = new Set(await inView());
      // Nothing runs off the foot of the screen.
      expect(await board.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
      const more = kds.getByRole("button", { name: /^\d+ more$/ });
      await expect(more).toHaveText(`${total - seen.size} more`);
      for (let i = 0; i < 10 && (await more.count()) > 0; i++) {
        await more.click();
        await kds.waitForTimeout(600);
        for (const l of await inView()) seen.add(l);
      }
      expect(seen.size).toBe(total);
      await expect(kds.getByRole("button", { name: /^\d+ before$/ })).toBeVisible();
      // Every Bump target is a 44px touch target.
      const smallest = await board.evaluate((el) => Math.min(...Array.from(el.querySelectorAll<HTMLElement>("[data-ticket] span.bg-primary")).map((b) => b.getBoundingClientRect().height)));
      expect(smallest).toBeGreaterThanOrEqual(44);
      await ctx.close();
    });
  }
  // Leave the board clean for the specs after this one.
  const left = await register<{ data: { id: string; order_no: string; customer_name: string | null }[] }>("GET", `/v1/outlets/${outletId}/kitchen-tickets`).catch(() => ({ data: [] }));
  for (const t of left.data.filter((x) => (x.customer_name ?? "").startsWith("KDS "))) await register("POST", `/v1/kitchen-tickets/${t.id}/bump`, {}).catch(() => undefined);
});

test("guest: a fresh table orders, a long kitchen note shows whole, and the phone says when it is offline (C Low)", async ({ browser, watch }) => {
  test.setTimeout(180_000);
  const { token } = await seatedTableToken();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await ctx.newPage();
  watch.attach(phone);
  await phone.goto(`${GUEST}/t/${token}`);
  await phone.getByRole("button", { name: /: see everything the table has ordered$/ }).click();
  await expect(phone.getByRole("button", { name: "Order", exact: true })).toBeVisible();
  await expect(phone.getByRole("button", { name: "Order more" })).toHaveCount(0);
  await phone.getByRole("button", { name: "Order", exact: true }).click();

  await phone.getByRole("button", { name: /^Kopi,/ }).click();
  const sheet = phone.getByRole("dialog", { name: "Kopi" });
  const note = sheet.getByRole("textbox", { name: "Note for the kitchen" });
  expect(await note.evaluate((el) => el.tagName)).toBe("TEXTAREA");
  await note.fill("Severe nut allergy, please keep it away from anything with peanuts or tree nuts");
  expect(await note.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  await sheet.getByRole("button", { name: /^Add to order/ }).click();
  await expect(sheet).toBeHidden();

  await ctx.setOffline(true);
  await expect(phone.getByRole("status").filter({ hasText: "No connection. Your order stays here until you are back online." })).toBeVisible();
  await ctx.setOffline(false);
  await expect(phone.getByText("No connection.")).toHaveCount(0);
  await ctx.close();
});

test("POS: the approval sheet says once what it approves, with the register's figures; the user menu is a full touch target (B-P15)", async ({ page }) => {
  test.setTimeout(240_000);
  await pairAndSignIn(page, "333333"); // a Cashier: % off bill needs a Manager
  const menu = page.getByRole("button", { name: /Open user menu$/ });
  expect((await menu.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Floor", exact: true }).click();
  await page.getByRole("button", { name: "Takeaway order", exact: true }).click();
  await page.getByRole("button", { name: /^Mee Goreng,/ }).click();
  await expect(page.getByRole("button", { name: "Send 1 to kitchen" })).toBeVisible();
  await page.getByRole("button", { name: "Discount", exact: true }).click();
  await page.getByRole("dialog").last().getByRole("button", { name: /% off bill/ }).click();
  const pad = page.getByRole("group", { name: "Amount keys" }).last();
  await pad.getByRole("button", { name: "1", exact: true }).click();
  await pad.getByRole("button", { name: "0", exact: true }).click();
  await page.getByRole("dialog").last().getByRole("button", { name: /^Apply / }).click();
  const approval = page.getByRole("dialog", { name: "Manager approval" });
  await expect(approval).toBeVisible();
  // 10% off: the register's dry run says what it takes off and what the order then comes to.
  await expect(approval.getByText(/^Apply % off bill · 10%$/)).toHaveCount(1);
  await expect(approval.getByText(/^Discount −\$\d+\.\d\d$/)).toBeVisible();
  await expect(approval.getByText(/^New total \$/)).toBeVisible();
  await page.keyboard.press("Escape");
});

test("POS: a pairing ended elsewhere goes straight to pairing and says why, once (B-P15)", async ({ page, browser, watch }) => {
  test.setTimeout(240_000);
  watch.allow({ status: 401, url: /\/v1\//, why: "the station was paired on another device, so this iPad's tokens stop working" });
  await pairAndSignIn(page, "333333");
  // Another iPad pairs to the same station: this one's pairing ends.
  const { stationId } = devLocal();
  const { data } = await register<{ data: { code: string } }>("POST", `/v1/stations/${stationId}/pairing-code`, {});
  const other = await browser.newPage();
  await other.goto(`${WEB}/pos`);
  await expect(other.getByRole("heading", { name: "Pair this iPad to a station" })).toBeVisible({ timeout: 180_000 });
  await keyIn(other, "PIN keys", data.code);
  await other.getByRole("button", { name: "Pair this iPad" }).click();
  await expect(other.getByRole("button", { name: "Pair this iPad again" })).toBeVisible();
  await other.close();
  // The next request this iPad makes (the live stream's, or a tap) learns the pairing ended.
  const orders = page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Orders", exact: true });
  if (await orders.isVisible().catch(() => false)) await orders.click({ timeout: 2_000 }).catch(() => undefined);
  await expect(page.getByRole("heading", { name: "Pair this iPad to a station" })).toBeVisible();
  await expect(page.getByText("This iPad is no longer paired to its station. Enter a new code from the back office.")).toBeVisible();
  await expect(page.getByText("Your session ended")).toHaveCount(0);
});

test("POS: a PIN sign-in the register does not answer is bounded and the pad is ready again (B-P15)", async ({ page, watch }) => {
  test.setTimeout(240_000);
  watch.allowConsole(/did not reply|aborted|signal/i);
  const { stationId } = devLocal();
  const { data } = await register<{ data: { code: string } }>("POST", `/v1/stations/${stationId}/pairing-code`, {});
  await page.goto(`${WEB}/pos`);
  await expect(page.getByRole("heading", { name: "Pair this iPad to a station" })).toBeVisible({ timeout: 180_000 });
  await keyIn(page, "PIN keys", data.code);
  await page.getByRole("button", { name: "Pair this iPad" }).click();
  await expect(page.getByRole("button", { name: "Pair this iPad again" })).toBeVisible();
  // The sign-in is held back for longer than its bound.
  await page.route(/\/v1\/stations\/sessions$/, async (route) => {
    await new Promise((r) => setTimeout(r, 12_000));
    await route.continue().catch(() => undefined);
  });
  const started = Date.now();
  await keyIn(page, "PIN keys", "333333");
  await expect(page.getByText(/did not reply within 8 seconds/)).toBeVisible({ timeout: 11_000 });
  expect(Date.now() - started).toBeLessThan(11_000);
  await page.unroute(/\/v1\/stations\/sessions$/);
  await keyIn(page, "PIN keys", "333333");
  await expect(page.getByRole("navigation", { name: "Destinations" })).toBeVisible();
});

test("POS: a burst refused for one line keeps every line the register can take (review of round 8, 4)", async ({ page, watch }) => {
  test.setTimeout(240_000);
  watch.allow({ status: 422, url: /\/v1\/orders\/[^/]+\/lines$/, why: "the day's cap runs out inside the burst, so the register refuses the batch and then the lines past the cap" });
  const { outletId } = devLocal();
  const products = await register<{ data: { id: string; name: string }[] }>("GET", "/v1/products?limit=100");
  const nasi = products.data.find((p) => p.name === "Nasi Lemak")!;
  await register("POST", "/v1/stock/daily-cap", { outlet_id: outletId, product_id: nasi.id, quantity: 5 });
  try {
    await pairAndSignIn(page, "333333");
    await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Floor", exact: true }).click();
    await page.getByRole("button", { name: "Takeaway order", exact: true }).click();
    // Adds answer late, as on a busy network, so the taps after the first wait and go together.
    await page.route(/\/v1\/orders\/[^/]+\/lines$/, async (route) => {
      if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, 300));
      await route.continue();
    });
    let orderId = "";
    page.on("request", (r) => {
      const m = /\/v1\/orders\/([^/]+)\/lines$/.exec(r.url());
      if (m && r.method() === "POST") orderId = m[1]!;
    });
    const tile = page.getByRole("button", { name: /^Nasi Lemak,/ });
    for (let i = 0; i < 7; i++) await tile.click();
    await expect(page.getByRole("button", { name: "Send 5 to kitchen" })).toBeVisible({ timeout: 30_000 });
    const order = await register<{ data: { lines: { product_id: string; status: string; quantity: number }[] } }>("GET", `/v1/orders/${orderId}`);
    expect(order.data.lines.filter((l) => l.product_id === nasi.id && l.status !== "voided").reduce((n, l) => n + l.quantity, 0)).toBe(5);
    await register("POST", `/v1/orders/${orderId}/cancel`, { reason: "End-to-end test" });
  } finally {
    await register("POST", "/v1/stock/daily-cap", { outlet_id: outletId, product_id: nasi.id, quantity: null }).catch(() => undefined);
  }
});
