import type { Locator, Page, Request } from "@playwright/test";
import { API, devDatabase, devLocal, expect, keyIn, pairAndSignIn, register, SG_ADMIN, test, WEB } from "./fixtures";

/**
 * The review fixes after the pilot polish (pairing on the button or Enter, the Stations sheet's code and status, the
 * floor's queued changes, Ready on a table's order, a station without a brand), checked in a browser as staff use them.
 * Runs in Chromium and in WebKit, the iPad's engine.
 */

const CASHIER_PIN = "333333";

async function signIn(page: Page) {
  await page.goto(`${WEB}/login`);
  await expect(async () => {
    await page.getByLabel("Email").fill(SG_ADMIN);
    await page.getByLabel("Password").fill(devLocal().admin_password);
    await page.getByRole("button", { name: "Sign in" }).click({ timeout: 10_000 });
    await page.waitForURL(`${WEB}/today`, { timeout: 30_000 });
  }).toPass({ timeout: 300_000 });
}

async function openRow(page: Page, name: string) {
  const sheet = page.getByRole("dialog", { name });
  await expect(async () => {
    await page.getByRole("rowheader", { name }).click({ timeout: 5_000 });
    await expect(sheet).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 120_000 });
  return sheet;
}

/** Count the iPad's pairing requests from here on. */
function countPairs(page: Page) {
  const seen: Request[] = [];
  const on = (r: Request) => {
    if (r.method() === "POST" && /\/v1\/stations\/pair$/.test(r.url())) seen.push(r);
  };
  page.on("request", on);
  return { get n() { return seen.length; }, stop: () => page.off("request", on) };
}

const box = async (l: Locator) => {
  const b = (await l.boundingBox())!;
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
};

async function newCode(stationId: string) {
  return (await register<{ data: { code: string } }>("POST", `/v1/stations/${stationId}/pairing-code`, {})).data.code;
}

test.describe("iPad pairing", () => {
  test.use({ viewport: { width: 1180, height: 820 } });

  test("six digits typed or pasted do not pair; the button and Enter in either field pair once; the form does not move for its errors", async ({ browser, watch }) => {
    test.setTimeout(420_000);
    const { outletId, brandId } = devLocal();
    const station = await register<{ data: { id: string } }>("POST", "/v1/stations", { name: `Pair check ${String(Date.now()).slice(-6)}`, kind: "pos", outlet_id: outletId, brand_id: brandId });
    watch.allow({ status: 401, url: /\/v1\/stations\/pair$/, why: "a wrong code and a replaced code, on purpose" });
    const devices: Page[] = [];
    const ipad = async () => {
      const p = await browser.newPage({ viewport: { width: 1180, height: 820 } });
      watch.attach(p);
      devices.push(p);
      await p.goto(`${WEB}/pos`);
      await expect(p.getByRole("heading", { name: "Pair this iPad to a station" })).toBeVisible({ timeout: 180_000 });
      return p;
    };
    const field = (p: Page) => p.getByRole("textbox", { name: "Pairing code from the back office" });
    const paired = (p: Page) => expect(p.getByRole("button", { name: "Pair this iPad again" })).toBeVisible();
    try {
      await test.step("typed: six digits wait for the button; the button pairs once", async () => {
        const p = await ipad();
        const code = await newCode(station.data.id);
        const pairs = countPairs(p);
        await field(p).pressSequentially(code);
        await p.waitForTimeout(1_500);
        expect(pairs.n, "pair requests after six typed digits").toBe(0);
        await expect(p.getByRole("heading", { name: "Pair this iPad to a station" })).toBeVisible();
        await p.getByRole("button", { name: "Pair this iPad", exact: true }).click();
        await paired(p);
        expect(pairs.n).toBe(1);
        pairs.stop();
      });

      await test.step("pasted: six digits wait too; Enter in the code field pairs once", async () => {
        const p = await ipad();
        const code = await newCode(station.data.id);
        const pairs = countPairs(p);
        await field(p).focus();
        await p.evaluate((text) => {
          const data = new DataTransfer();
          data.setData("text/plain", text);
          document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        }, `${code.slice(0, 3)}-${code.slice(3)}`);
        await expect(field(p)).toHaveValue(code);
        await p.waitForTimeout(1_500);
        expect(pairs.n, "pair requests after a pasted code").toBe(0);
        await field(p).press("Enter");
        await paired(p);
        await p.waitForTimeout(500);
        expect(pairs.n).toBe(1);
        pairs.stop();
      });

      await test.step("Enter in the name field pairs once", async () => {
        const p = await ipad();
        const code = await newCode(station.data.id);
        const pairs = countPairs(p);
        await field(p).fill(code);
        const name = p.getByRole("textbox", { name: "Name for this iPad" });
        await name.fill("Counter iPad");
        await name.press("Enter");
        await paired(p);
        await p.waitForTimeout(500);
        expect(pairs.n).toBe(1);
        pairs.stop();
      });

      await test.step("Wrong code and the two-line replaced message leave the heading and the field where they were", async () => {
        const p = await ipad();
        const heading = p.getByRole("heading", { name: "Pair this iPad to a station" });
        const before = { heading: await box(heading), field: await box(field(p)), button: await box(p.getByRole("button", { name: "Pair this iPad", exact: true })) };
        const replaced = await newCode(station.data.id);
        const live = await newCode(station.data.id);
        const wrong = ["135790", "246801"].find((c) => c !== live && c !== replaced)!;
        await field(p).fill(wrong);
        await field(p).press("Enter");
        await expect(p.getByRole("alert").filter({ hasText: "Wrong code." })).toBeVisible();
        expect({ heading: await box(heading), field: await box(field(p)), button: await box(p.getByRole("button", { name: "Pair this iPad", exact: true })) }, "after Wrong code").toEqual(before);
        await field(p).fill(replaced);
        await field(p).press("Enter");
        const two = p.getByRole("alert").filter({ hasText: "expired or was replaced" });
        await expect(two).toBeVisible();
        const lines = await two.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
        expect(lines, "the replaced message takes two lines").toBe(2);
        expect({ heading: await box(heading), field: await box(field(p)), button: await box(p.getByRole("button", { name: "Pair this iPad", exact: true })) }, "after the replaced message").toEqual(before);
      });

      await test.step("the kitchen display still pairs on its keys", async () => {
        const stations = await register<{ data: { id: string; kind: string; outlet_id: string; archived: boolean }[] }>("GET", "/v1/stations");
        const display = stations.data.find((s) => s.kind === "display" && s.outlet_id === outletId && !s.archived)!;
        const kds = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        watch.attach(kds);
        devices.push(kds);
        await kds.goto(`${WEB}/kds`);
        const code = await newCode(display.id);
        await keyIn(kds, "PIN keys", code);
        await kds.getByRole("button", { name: "Pair this screen", exact: true }).click();
        await expect(kds.getByRole("region", { name: "Tickets" })).toBeVisible({ timeout: 60_000 });
      });
    } finally {
      for (const p of devices) await p.close();
      await register("PATCH", `/v1/stations/${station.data.id}`, { archived: true });
    }
  });
});

test.describe("back office", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Stations sheet: the new code shows whole above the footer, the same code on reopening, and the subtitle turns to Paired by itself", async ({ page }) => {
    test.setTimeout(300_000);
    const { outletId, brandId } = devLocal();
    const name = `Code check ${String(Date.now()).slice(-6)}`;
    const station = await register<{ data: { id: string } }>("POST", "/v1/stations", { name, kind: "pos", outlet_id: outletId, brand_id: brandId });
    try {
      await signIn(page);
      await page.goto(`${WEB}/settings/stations`);
      let sheet = await openRow(page, name);
      await expect(sheet.getByText("Not paired", { exact: true })).toBeVisible();
      await sheet.getByRole("button", { name: "Pair an iPad" }).click();
      const code = sheet.getByLabel(/^Pairing code \d/);
      await expect(code).toBeVisible();
      await page.waitForTimeout(600);
      const c = (await code.boundingBox())!;
      const footer = (await sheet.locator("footer").boundingBox())!;
      const header = (await sheet.locator("header").first().boundingBox())!;
      expect(c.y, "the code's top is below the sheet's header").toBeGreaterThanOrEqual(header.y + header.height - 0.5);
      expect(c.y + c.height, "the code's bottom is above the footer").toBeLessThanOrEqual(footer.y + 0.5);
      const digits = ((await code.getAttribute("aria-label")) ?? "").replace(/\D/g, "");

      await sheet.getByRole("button", { name: "Cancel" }).click();
      await expect(sheet).toBeHidden();
      sheet = await openRow(page, name);
      await expect(sheet.getByLabel(/^Pairing code \d/)).toBeVisible();
      expect(((await sheet.getByLabel(/^Pairing code \d/).getAttribute("aria-label")) ?? "").replace(/\D/g, "")).toBe(digits);

      // A device pairs while the sheet is open: the subtitle follows without reopening.
      const res = await fetch(`${API}/v1/stations/pair`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ code: digits, device_label: "Window iPad" }) });
      expect(res.ok).toBe(true);
      await expect(sheet.getByText("Paired · Window iPad", { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(sheet.getByText("Not paired", { exact: true })).toHaveCount(0);
    } finally {
      await register("PATCH", `/v1/stations/${station.data.id}`, { archived: true });
    }
  });

  test("Floor & QR: two quick drags, or a drag then a typed X, never put the table back; a refused name says Not saved yet until typed back", async ({ page }) => {
    test.setTimeout(300_000);
    const { outletId } = devLocal();
    type T = { id: string; name: string; x: number; y: number; w: number; h: number };
    const areaName = `Drag ${String(Date.now()).slice(-5)}`;
    const area = await register<{ data: { id: string } }>("POST", "/v1/areas", { outlet_id: outletId, name: areaName, sort: 61 });
    const table = (await register<{ data: T }>("POST", "/v1/tables", { outlet_id: outletId, area_id: area.data.id, name: "D1", seats: 2, x: 2, y: 2, w: 2, h: 2 })).data;
    const read = async () => (await register<{ data: T[] }>("GET", `/v1/tables?outlet_id=${outletId}&area_id=${area.data.id}`)).data.find((t) => t.id === table.id)!;
    try {
      await signIn(page);
      await page.goto(`${WEB}/floor`);
      const plan = page.getByRole("application", { name: `Floor plan for ${areaName}` });
      await expect(async () => {
        await page.getByRole("navigation", { name: "Areas" }).getByRole("button", { name: areaName, exact: true }).click({ timeout: 5_000 });
        await expect(plan).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 120_000 });
      // Every save takes a while, so the second change starts while the first is still on its way.
      await page.route(new RegExp(`/v1/tables/${table.id}$`), async (route) => {
        if (route.request().method() === "PATCH") await new Promise((r) => setTimeout(r, 700));
        await route.continue();
      });
      const tile = plan.getByRole("button", { name: /^D1,/ });
      const cell = (await plan.boundingBox())!.width / 24;
      // The tile's column, read from its inline left ("calc(25% + 3px)").
      const left = () => tile.evaluate((el) => Math.round((parseFloat(/([\d.]+)%/.exec((el as HTMLElement).style.left)?.[1] ?? "NaN") * 24) / 100));
      const drag = async (dx: number, dy: number) => {
        const b = (await tile.boundingBox())!;
        await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
        await page.mouse.down();
        await page.mouse.move(b.x + b.width / 2 + dx * cell, b.y + b.height / 2 + dy * cell, { steps: 6 });
        await page.mouse.up();
      };
      /** Watch the tile's left edge for a while: it must reach `want` and never show `never` once it has. */
      const watchLeft = async (want: number, never: number[]) => {
        const seen: number[] = [];
        for (let i = 0; i < 30; i++) {
          seen.push(await left());
          await page.waitForTimeout(100);
        }
        const from = seen.indexOf(want);
        expect(from, `the table reaches ${want}: ${seen.join(" ")}`).toBeGreaterThanOrEqual(0);
        for (const s of seen.slice(from)) expect(never, `jumped back: ${seen.join(" ")}`).not.toContain(s);
      };
      const at = (x: number) => x;

      await test.step("two quick drags", async () => {
        await drag(3, 0);
        await drag(3, 0);
        await watchLeft(at(8), [at(2), at(5)]);
        await expect.poll(async () => (await read()).x, { timeout: 15_000 }).toBe(8);
        await page.waitForTimeout(1_500);
        expect(await left()).toBe(at(8));
      });

      await test.step("a drag, then a typed X", async () => {
        const panel = page.locator("aside");
        await drag(-2, 0);
        await panel.getByRole("textbox", { name: "X", exact: true }).fill("12");
        await panel.getByRole("textbox", { name: "X", exact: true }).blur();
        await watchLeft(at(12), [at(8), at(6)]);
        await expect.poll(async () => (await read()).x, { timeout: 15_000 }).toBe(12);
        await page.waitForTimeout(1_500);
        expect(await left()).toBe(at(12));
        await expect(panel.getByRole("textbox", { name: "X", exact: true })).toHaveValue("12");
      });

      await test.step("a refused name says Not saved yet until the saved name is typed back", async () => {
        const panel = page.locator("aside");
        await page.unroute(new RegExp(`/v1/tables/${table.id}$`));
        await page.route(new RegExp(`/v1/tables/${table.id}$`), async (route) => {
          if (route.request().method() === "PATCH" && (route.request().postDataJSON() as { name?: string }).name === "Nope") return route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ code: "validation_failed", message: "That name is refused", remedy: "Choose another name." }) });
          return route.continue();
        });
        await panel.getByRole("textbox", { name: "Name" }).fill("Nope");
        await expect(panel.getByText("Not saved yet.")).toBeVisible();
        await page.waitForTimeout(1_000);
        await expect(panel.getByText("Not saved yet.")).toBeVisible();
        await panel.getByRole("textbox", { name: "Name" }).fill("D1");
        await expect(panel.getByText("Not saved yet.")).toHaveCount(0);
        await expect(panel.getByText("Saved", { exact: true })).toBeVisible();
      });
    } finally {
      await register("PATCH", `/v1/tables/${table.id}`, { archived: true });
    }
  });

  test("Floor & QR with Scan to order off: one amber note, and no red line", async ({ page }) => {
    test.setTimeout(240_000);
    const { outletId } = devLocal();
    const links = await register<{ data: { id: string; outlet_id: string; enabled: boolean }[] }>("GET", `/v1/channel-links?channel=scan_to_order&outlet_id=${outletId}`);
    const link = links.data.find((l) => l.outlet_id === outletId && l.enabled)!;
    await register("PATCH", `/v1/channel-links/${link.id}`, { enabled: false });
    try {
      await signIn(page);
      await page.goto(`${WEB}/floor`);
      const note = page.getByRole("alert").filter({ hasText: "do not take orders yet" });
      await expect(note).toHaveCount(1);
      await expect(page.getByText(/do not take orders yet/)).toHaveCount(1);
      // Amber: the note's text is the sent (amber) status ink, and nothing on the page is in the alert (red) ink.
      const colours = await page.evaluate(() => {
        const probe = (v: string) => {
          const s = document.createElement("span");
          s.style.color = `var(${v})`;
          document.body.appendChild(s);
          const c = getComputedStyle(s).color;
          s.remove();
          return c;
        };
        const red = probe("--status-alert");
        const amber = probe("--status-sent");
        const main = document.querySelector("main")!;
        const reds = Array.from(main.querySelectorAll<HTMLElement>("*")).filter((el) => el.childNodes.length && Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim()) && getComputedStyle(el).color === red).map((el) => el.textContent!.slice(0, 40));
        return { red, amber, reds };
      });
      expect(colours.reds, "text in the alert ink").toEqual([]);
      expect(colours.red).not.toBe(colours.amber);
    } finally {
      await register("PATCH", `/v1/channel-links/${link.id}`, { enabled: true });
    }
  });

  test("Stations sheet: Save with no brand gives the Brand select a red border, in Day and Service", async ({ page }) => {
    test.setTimeout(240_000);
    const { merchantId, outletId } = devLocal();
    const old = { id: crypto.randomUUID(), name: `Brandless ${String(Date.now()).slice(-6)}` };
    const sql = devDatabase();
    await sql`insert into stations (id, merchant_id, outlet_id, name) values (${old.id}, ${merchantId}, ${outletId}, ${old.name})`;
    await sql.end();
    try {
      await signIn(page);
      await page.goto(`${WEB}/settings/stations`);
      const sheet = await openRow(page, old.name);
      await sheet.getByRole("button", { name: "Save changes" }).click();
      await expect(sheet.getByText("Choose a brand", { exact: true }).last()).toBeVisible();
      const brand = sheet.getByRole("button", { name: /Brand/ });
      for (const theme of ["day", "service"] as const) {
        await page.evaluate((t) => (t === "service" ? (document.documentElement.dataset.theme = "service") : delete document.documentElement.dataset.theme), theme);
        await page.waitForTimeout(400);
        const { border, red } = await brand.evaluate((el) => {
          const s = document.createElement("span");
          s.style.color = "var(--status-alert)";
          document.body.appendChild(s);
          const red = getComputedStyle(s).color;
          s.remove();
          return { border: getComputedStyle(el).borderTopColor, red };
        });
        expect(border, `${theme}: the Brand select's border`).toBe(red);
        await page.screenshot({ path: `test-results/brandless-select-${theme}.png` });
      }
    } finally {
      await register("PATCH", `/v1/stations/${old.id}`, { archived: true }).catch(() => undefined);
    }
  });
});

test.describe("POS", () => {
  test.use({ viewport: { width: 1180, height: 820 } });

  test("Orders: a sent dine-in order has no Ready, a pickup has; a station without a brand opens Shift and Orders, and its empty Orders list does not point at New order", async ({ page, browser, watch }) => {
    test.setTimeout(360_000);
    const { merchantId, outletId, brandId } = devLocal();
    const opened: string[] = [];
    const old = { id: crypto.randomUUID(), name: `No brand ${String(Date.now()).slice(-6)}` };
    try {
      await test.step("Ready: not on a sent table order, on a sent pickup", async () => {
        const floor = await register<{ data: { tables: { id: string; name: string; order: unknown }[] } }>("GET", `/v1/outlets/${outletId}/floor`);
        const table = floor.data.tables.find((t) => !t.order)!;
        const products = await register<{ data: { id: string; name: string }[] }>("GET", "/v1/products?limit=100");
        const kopi = products.data.find((p) => p.name === "Kopi")!;
        for (const body of [{ order_type: "dine_in", table_id: table.id, pax: 2 }, { order_type: "pickup", customer_ref: { name: "Ready check" } }]) {
          const id = crypto.randomUUID();
          await register("POST", "/v1/orders", { order_id: id, outlet_id: outletId, brand_id: brandId, ...body });
          opened.push(id);
          await register("POST", `/v1/orders/${id}/lines`, { lines: [{ line_id: crypto.randomUUID(), product_id: kopi.id, quantity: 1 }] });
          await register("POST", `/v1/orders/${id}/fire`, {});
        }
        await pairAndSignIn(page, CASHIER_PIN);
        await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Orders", exact: true }).click();
        const dineIn = page.getByRole("listitem").filter({ has: page.getByRole("button", { name: /^Dine-in / }).filter({ hasText: `Table ${table.name} · Dine-in` }) });
        const pickup = page.getByRole("listitem").filter({ has: page.getByRole("button", { name: /^Pickup .*Ready check/ }) });
        await expect(dineIn).toHaveCount(1);
        await expect(pickup).toHaveCount(1);
        await expect(dineIn.getByRole("button", { name: "Ready", exact: true })).toHaveCount(0);
        await expect(pickup.getByRole("button", { name: "Ready", exact: true })).toBeVisible();
      });

      await test.step("a station without a brand: Shift and Orders open; the empty Orders list does not mention New order", async () => {
        for (const id of opened.splice(0)) await register("POST", `/v1/orders/${id}/cancel`, { reason: "End-to-end test" }).catch(() => undefined);
        const sql = devDatabase();
        await sql`insert into stations (id, merchant_id, outlet_id, name) values (${old.id}, ${merchantId}, ${outletId}, ${old.name})`;
        await sql.end();
        const ipad = await browser.newPage({ viewport: { width: 1180, height: 820 } });
        watch.attach(ipad);
        try {
          await pairAndSignIn(ipad, CASHIER_PIN, "sg", old.id, { noBrand: true });
          const tabs = ipad.getByRole("navigation", { name: "Destinations" });
          await tabs.getByRole("button", { name: "Shift", exact: true }).click();
          await expect(ipad.getByRole("heading", { name: "This station has no brand" })).toHaveCount(0);
          await expect(ipad.getByRole("heading", { name: /^(Open shift|Shift open)$/ })).toBeVisible();
          await tabs.getByRole("button", { name: "Orders", exact: true }).click();
          await expect(ipad.getByRole("group", { name: "Which orders" })).toBeVisible();
          // Today's closed on a fresh station is an empty list; neither it nor Open points at New order.
          const main = ipad.getByRole("main");
          await expect(main).not.toContainText("New order");
          await ipad.getByRole("group", { name: "Which orders" }).getByRole("button", { name: /^Today's closed/ }).click();
          await expect(main).not.toContainText("New order");
          await ipad.screenshot({ path: "test-results/brandless-orders.png" });
        } finally {
          await ipad.close();
        }
      });
    } finally {
      for (const id of opened) await register("POST", `/v1/orders/${id}/cancel`, { reason: "End-to-end test" }).catch(() => undefined);
      await register("PATCH", `/v1/stations/${old.id}`, { archived: true }).catch(() => undefined);
    }
  });
});
