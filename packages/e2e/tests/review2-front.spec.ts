import type { Page } from "@playwright/test";
import { API, devLocal, expect, GUEST, keyIn, pairAndSignIn, register, SG_ADMIN, shot, test, WEB } from "./fixtures";

/**
 * Second review round, front (`fix/review2-front`): the guest phone's round stages and totals, what the phone says when
 * a session ends, rejecting a QR order as Sold out, the kitchen display's paging, and the back office's Changes page.
 * The register's side is held by `server/test/guest.test.ts` and `server/test/audit-labels.test.ts`; these check what
 * the screens show and take the shots for the report (both themes where the screen has two).
 */
const MANAGER_PIN = "222222";
const out = (name: string) => (process.env.REVIEW2_SHOTS ? `${process.env.REVIEW2_SHOTS}/${name}` : test.info().outputPath(name));

async function bothThemes(page: Page, name: string) {
  for (const theme of ["day", "service"] as const) {
    await page.evaluate((t) => (t === "service" ? (document.documentElement.dataset.theme = "service") : delete document.documentElement.dataset.theme), theme);
    await page.waitForTimeout(150);
    await shot(page, out(`${name}-${theme}.png`));
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
}

type Product = { id: string; name: string };
async function products(): Promise<Record<string, string>> {
  const p = await register<{ data: Product[] }>("GET", "/v1/products?limit=60");
  return Object.fromEntries(p.data.map((x) => [x.name, x.id]));
}

/** A dine-in order on a free table, its QR code, and a phone session on it (made through the API: the phone page opens it after). */
async function seatedTable() {
  const { outletId, brandId } = devLocal();
  const floor = await register<{ data: { tables: { id: string; name: string; area_id: string; order: unknown }[] } }>("GET", `/v1/outlets/${outletId}/floor`);
  const area = floor.data.tables[0]!.area_id;
  const table = floor.data.tables.find((t) => !t.order && t.area_id === area) ?? floor.data.tables.find((t) => !t.order)!;
  const order = await register<{ data: { id: string; order_no: string } }>("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "dine_in", table_id: table.id, pax: 2, outlet_id: outletId, brand_id: brandId });
  const qr = await register<{ data: { url: string } }>("POST", `/v1/tables/${table.id}/qr/rotate`, {});
  return { order: order.data, table, token: qr.data.url.split("/t/")[1]! };
}

/** The phone's guest token, read from the page's own session (so API rounds come from the same phone). */
async function phoneToken(phone: Page): Promise<string> {
  return phone.evaluate(() => {
    for (let i = 0; i < sessionStorage.length; i++) {
      const v = sessionStorage.getItem(sessionStorage.key(i)!) ?? "";
      if (v.includes("guest_token")) return (JSON.parse(v) as { guest_token: string }).guest_token;
    }
    throw new Error("no guest session on the page");
  });
}

const lastSend = new Map<string, number>();
async function sendRound(guest: string, lines: { product_id: string; quantity: number }[]): Promise<string> {
  const roundId = crypto.randomUUID();
  // A phone may send a round every 10 s: a second round waits out the register's limit, as a guest would.
  const last = lastSend.get(guest) ?? 0;
  if (Date.now() - last < 11_000) await new Promise((r) => setTimeout(r, 11_000 - (Date.now() - last)));
  lastSend.set(guest, Date.now());
  const r = await fetch(`${API}/v1/guest/rounds`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${guest}`, "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ round_id: roundId, lines: lines.map((l) => ({ line_id: crypto.randomUUID(), ...l })) }) });
  expect(r.status, await r.clone().text()).toBe(201);
  return roundId;
}

async function bumpAll(orderId: string) {
  const tickets = await register<{ data: { id: string; order_id: string }[] }>("GET", `/v1/outlets/${devLocal().outletId}/kitchen-tickets`);
  for (const t of tickets.data.filter((x) => x.order_id === orderId)) await register("POST", `/v1/kitchen-tickets/${t.id}/bump`, {}).catch(() => undefined);
}

/** Leave nothing behind: waiting rounds turned down, the order paid and completed (or cancelled), tickets bumped. */
async function settle(orderId: string) {
  const rounds = await register<{ data: { id: string; order_id: string }[] }>("GET", `/v1/outlets/${devLocal().outletId}/rounds?status=pending`);
  for (const r of rounds.data.filter((x) => x.order_id === orderId)) await register("POST", `/v1/rounds/${r.id}/reject`, { reason: "Test over" }).catch(() => undefined);
  const o = await register<{ data: { status: string } }>("GET", `/v1/orders/${orderId}`);
  if (o.data.status !== "completed" && o.data.status !== "cancelled") {
    const tenders = await register<{ data: { id: string; is_cash: boolean; provider?: string | null }[] }>("GET", "/v1/tender-types");
    const byHand = tenders.data.find((t) => !t.is_cash && !t.provider)!;
    const now = await register<{ data: { checks: { id: string; balance: number }[]; lines: unknown[] } }>("GET", `/v1/orders/${orderId}`);
    if (now.data.lines.length === 0) await register("POST", `/v1/orders/${orderId}/cancel`, { reason: "Test over" }).catch(() => undefined);
    else {
      for (const c of now.data.checks.filter((x) => x.balance > 0)) await register("POST", `/v1/checks/${c.id}/payments`, { payment_id: crypto.randomUUID(), tender_type_id: byHand.id, amount: c.balance });
      await register("POST", `/v1/orders/${orderId}/complete`, {}).catch(() => undefined);
    }
  }
  await bumpAll(orderId);
}

test("G1–G3: round 2 stays Preparing after round 1 is bumped; the banner follows; a waiting round has its own total, apart from the bill", async ({ browser, watch }) => {
  test.setTimeout(300_000);
  const ids = await products();
  const { order, token } = await seatedTable();
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  watch.attach(phone);
  try {
    await phone.goto(`${GUEST}/t/${token}`);
    await expect(phone.getByRole("button", { name: /^Otah,/ })).toBeVisible({ timeout: 120_000 });
    const guest = await phoneToken(phone);

    const r1 = await sendRound(guest, [{ product_id: ids["Otah"]!, quantity: 1 }]);
    await phone.goto(`${GUEST}/t/${token}#status`);
    await test.step("waiting: the round's own total, not on the bill; no table figures for an empty bill", async () => {
      const round = phone.getByRole("region", { name: "Latest order" });
      await expect(round).toContainText("Not on the bill until staff accept it");
      await expect(round).toContainText("$9.00");
      await expect(phone.getByRole("region", { name: "Table total" })).toHaveCount(0);
      await shot(phone, out("G3-phone-waiting-first-round.png"));
    });

    await register("POST", `/v1/rounds/${r1}/accept`, {});
    await expect(phone.getByRole("heading", { name: "Order accepted" })).toBeVisible();
    await expect(phone.getByText("The kitchen is preparing it.")).toBeVisible();
    await bumpAll(order.id);
    await test.step("bumped: Done, and the banner goes (it no longer says the kitchen is preparing it)", async () => {
      await expect(phone.getByRole("region", { name: "Latest order" }).getByText("Done", { exact: true }).first()).toBeVisible();
      await expect(phone.getByText("The kitchen is preparing it.")).toHaveCount(0);
      await expect(phone.getByRole("heading", { name: "Order accepted" })).toHaveCount(0);
      await shot(phone, out("G2-phone-round1-done.png"));
    });

    const r2 = await sendRound(guest, [{ product_id: ids["Popiah"]!, quantity: 2 }]);
    await test.step("round 2 waiting on an order with a bill: its own total, and the table's figures say so far", async () => {
      const latest = phone.getByRole("region", { name: "Latest order" });
      await expect(latest).toContainText("Not on the bill until staff accept it");
      await expect(latest).toContainText("$12.00");
      await expect(phone.getByRole("region", { name: "Table total" })).toContainText("On the bill so far");
      await shot(phone, out("G3-phone-waiting-second-round.png"));
    });
    await register("POST", `/v1/rounds/${r2}/accept`, {});
    await test.step("round 2 accepted while the order is ready from round 1: Preparing, not Done", async () => {
      const o = await register<{ data: { status: string } }>("GET", `/v1/orders/${order.id}`);
      test.info().annotations.push({ type: "order status after round 2", description: o.data.status });
      const latest = phone.getByRole("region", { name: "Latest order" });
      // The pill and the timeline's current step both say Preparing; "Done" is only the timeline's step still to come.
      await expect(latest.getByText("Preparing", { exact: true })).toHaveCount(2);
      await expect(latest.getByText("Done", { exact: true })).toHaveCount(1);
      await expect(phone.getByText("The kitchen is preparing it.")).toBeVisible();
      await expect(phone.getByRole("region", { name: "Table total" })).not.toContainText("On the bill so far");
      await shot(phone, out("G1-phone-round2-preparing.png"));
      await phone.getByRole("button", { name: /^Our table/ }).click();
      await expect(phone.getByRole("heading", { name: "Our table" })).toBeVisible();
      await shot(phone, out("G1-phone-our-table.png"));
    });
  } finally {
    await phone.close();
    await settle(order.id);
  }
});

test("G4, G5: Order again opens the menu; a cancelled order says the restaurant cancelled it, and the POS cancel sheet names the waiting QR order", async ({ browser, page, watch }) => {
  test.setTimeout(300_000);
  watch.allow({ status: 401, url: /\/v1\/guest\//, why: "the session ends on purpose" });
  const ids = await products();

  await test.step("paid: Order again lands on the menu, with no sheet and no #status", async () => {
    const { order, token } = await seatedTable();
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    watch.attach(phone);
    try {
      await phone.goto(`${GUEST}/t/${token}`);
      await expect(phone.getByRole("button", { name: /^Otah,/ })).toBeVisible({ timeout: 120_000 });
      const r = await sendRound(await phoneToken(phone), [{ product_id: ids["Otah"]!, quantity: 1 }]);
      await register("POST", `/v1/rounds/${r}/accept`, {});
      await phone.goto(`${GUEST}/t/${token}#status`);
      await phone.getByRole("button", { name: "Call staff" }).click();
      await expect(phone.getByRole("dialog")).toBeVisible();
      await settle(order.id);
      await expect(phone.getByRole("heading", { name: "Your bill is paid." })).toBeVisible({ timeout: 30_000 });
      await phone.getByRole("button", { name: "Order again" }).click();
      // The table is free again, so the new session's menu waits for staff to seat it: the menu, not the old status page.
      await expect(phone.getByText(/isn.t ready for ordering yet/)).toBeVisible({ timeout: 30_000 });
      expect(new URL(phone.url()).hash).toBe("");
      await expect(phone.getByRole("dialog")).toHaveCount(0);
      await expect(phone.getByText("No orders have been sent from this phone yet.")).toHaveCount(0);
      await shot(phone, out("G4-phone-order-again-menu.png"));
    } finally {
      await phone.close();
    }
  });

  await test.step("cancelled by staff with a QR order waiting: the POS sheet says so; the phone says the restaurant cancelled it", async () => {
    const { order, table, token } = await seatedTable();
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    watch.attach(phone);
    try {
      await phone.goto(`${GUEST}/t/${token}`);
      await expect(phone.getByRole("button", { name: /^Otah,/ })).toBeVisible({ timeout: 120_000 });
      await sendRound(await phoneToken(phone), [{ product_id: ids["Otah"]!, quantity: 1 }]);
      await phone.goto(`${GUEST}/t/${token}#status`);
      await expect(phone.getByRole("heading", { name: "Order sent" })).toBeVisible();

      await pairAndSignIn(page, MANAGER_PIN);
      await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Floor", exact: true }).click();
      await page.getByRole("button", { name: new RegExp(`^Table ${table.name},`) }).first().click();
      await page.getByRole("button", { name: "Order", exact: true }).click();
      await page.getByRole("menuitem", { name: "Cancel order" }).click();
      const sheet = page.getByRole("dialog", { name: "Cancel order" });
      await expect(sheet).toContainText("The QR order waiting on it is turned down, and the guest is told.");
      await bothThemes(page, "G5-pos-cancel-sheet");
      await sheet.getByRole("button", { name: "Walked out" }).click();
      await expect(sheet).toHaveCount(0);

      await expect(phone.getByRole("heading", { name: "The restaurant cancelled this order." })).toBeVisible({ timeout: 30_000 });
      await expect(phone.getByText("This table session has ended.")).toHaveCount(0);
      await shot(phone, out("G5-phone-cancelled.png"));
    } finally {
      await phone.close();
      await settle(order.id);
    }
  });
});

test("G6: rejecting a two-item QR order as Sold out from the Now card asks which; only the ticked one is sold out, and the open phone shows it without a reload", async ({ browser, page, watch }) => {
  test.setTimeout(300_000);
  const ids = await products();
  const { outletId } = devLocal();
  const { order, table, token } = await seatedTable();
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  watch.attach(phone);
  try {
    await phone.goto(`${GUEST}/t/${token}`);
    await expect(phone.getByRole("button", { name: /^Otah,/ })).toBeVisible({ timeout: 120_000 });
    await sendRound(await phoneToken(phone), [
      { product_id: ids["Otah"]!, quantity: 1 },
      { product_id: ids["Popiah"]!, quantity: 1 },
    ]);
    await pairAndSignIn(page, MANAGER_PIN);
    const rail = page.getByRole("complementary", { name: "Now" });
    const item = rail.getByRole("listitem").filter({ hasText: `Table ${table.name} · QR order` }).first();
    await item.getByRole("button", { name: "Reject" }).click();
    const sheet = page.getByRole("dialog", { name: "Reject QR order" });
    await sheet.getByRole("button", { name: "Sold out", exact: true }).click();
    const choice = sheet.getByRole("group", { name: "Which items are sold out?" });
    // Two items: none ticked until staff say which.
    await expect(choice.getByRole("checkbox", { name: "Otah" })).not.toBeChecked();
    await expect(choice.getByRole("checkbox", { name: "Popiah" })).not.toBeChecked();
    await choice.getByText("Otah").click();
    await bothThemes(page, "G6-pos-reject-sold-out");
    await sheet.getByRole("button", { name: "Reject as sold out" }).click();
    await expect(sheet).toHaveCount(0);
    await expect.poll(async () => (await register<{ data: { product_id: string }[] }>("GET", `/v1/outlets/${outletId}/stock`)).data.map((s) => s.product_id)).toContain(ids["Otah"]!);
    const stock = await register<{ data: { product_id: string; sold_out: boolean }[] }>("GET", `/v1/outlets/${outletId}/stock`);
    expect(stock.data.filter((s) => s.sold_out).map((s) => s.product_id)).not.toContain(ids["Popiah"]!);
    // The open phone's menu says Sold out by itself (the stock change reaches it), with no reload.
    await expect(phone.getByRole("button", { name: /^Otah,/ })).toHaveCount(0, { timeout: 10_000 });
    await expect(phone.getByText("Sold out", { exact: true }).first()).toBeVisible();
    await expect(phone.getByRole("button", { name: /^Popiah,/ })).toBeVisible();
    await shot(phone, out("G6-phone-menu-sold-out.png"));
  } finally {
    await phone.close();
    await register("POST", "/v1/stock/restore", { outlet_id: outletId, product_id: ids["Otah"]! }).catch(() => undefined);
    await settle(order.id);
  }
});

test("G7: the kitchen display pages by whole pages: nothing of the other page shows or takes a tap; the name stays readable at 1024", async ({ browser, watch }) => {
  test.setTimeout(400_000);
  const { outletId, brandId } = devLocal();
  const stations = await register<{ data: { id: string; name: string; kind: string }[] }>("GET", `/v1/outlets/${outletId}/stations`);
  const display = stations.data.find((s) => s.kind === "display")!;
  const ids = await products();
  const made: string[] = [];
  for (let i = 1; i <= 13; i++) {
    const o = await register<{ data: { id: string } }>("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "takeaway", takeaway_ref: `R2 ${i}`, outlet_id: outletId, brand_id: brandId });
    made.push(o.data.id);
    await register("POST", `/v1/orders/${o.data.id}/lines`, { lines: [{ line_id: crypto.randomUUID(), product_id: ids["Char Kway Teow"]!, quantity: 1 }, { line_id: crypto.randomUUID(), product_id: ids["Otah"]!, quantity: 1 }] });
    await register("POST", `/v1/orders/${o.data.id}/fire`, {});
  }
  try {
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
        await expect(board.getByRole("button", { name: /R2 13/ })).toBeAttached();
        // The station's name is whole in the bar, with both paging buttons there.
        const name = kds.getByText(display.name, { exact: true });
        const fits = () => name.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1);
        expect(await fits()).toBe(true);
        await shot(kds, out(`G7-kds-${viewport.width}-first-page.png`));
        // Any card of another page that shows inside the board, or takes the tap at the board's edges.
        const leak = () =>
          board.evaluate((el) => {
            const scroller = el.querySelector<HTMLElement>("[data-ticket]")!.closest<HTMLElement>(".overflow-x-auto")!;
            const box = scroller.getBoundingClientRect();
            const partial = Array.from(el.querySelectorAll<HTMLElement>("[data-ticket]")).filter((c) => {
              const r = c.getBoundingClientRect();
              return r.right > box.left + 1 && r.left < box.right - 1 && (r.left < box.left - 1 || r.right > box.right + 1);
            }).length;
            const edgeHits = [box.left - 8, box.right + 8].map((x) => document.elementFromPoint(x, box.top + 60)?.closest("[data-ticket]") ?? null).filter(Boolean).length;
            return { partial, edgeHits };
          });
        expect(await leak()).toEqual({ partial: 0, edgeHits: 0 });
        const more = kds.getByRole("button", { name: /^\d+ more$/ });
        for (let i = 0; i < 8 && (await more.count()) > 0; i++) {
          await more.click();
          await kds.waitForTimeout(700);
          expect(await leak()).toEqual({ partial: 0, edgeHits: 0 });
          await expect(kds.getByRole("button", { name: /^\d+ before$/ })).toBeVisible();
          expect(await fits()).toBe(true);
          if (i === 0) await shot(kds, out(`G7-kds-${viewport.width}-next-page.png`));
        }
        await kds.evaluate(() => (document.documentElement.dataset.theme = "service"));
        await shot(kds, out(`G7-kds-${viewport.width}-last-page-service.png`));
        await ctx.close();
      });
    }
  } finally {
    for (const id of made) await settle(id);
  }
});

test("G8: Changes reads in an owner's words, and its filters live in the address", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  // A menu archived and restored, so the log has both.
  const menus = await register<{ data: { id: string; name: string }[] }>("GET", "/v1/menus");
  const m = menus.data[0]!;
  await register("PATCH", `/v1/menus/${m.id}`, { archived: true });
  await register("PATCH", `/v1/menus/${m.id}`, { archived: false });
  await page.goto(`${WEB}/login`);
  await expect(async () => {
    await page.getByLabel("Email").fill(SG_ADMIN);
    await page.getByLabel("Password").fill(devLocal().admin_password);
    await page.getByRole("button", { name: "Sign in" }).click({ timeout: 10_000 });
    await page.waitForURL(`${WEB}/today`, { timeout: 30_000 });
  }).toPass({ timeout: 300_000 });
  await page.goto(`${WEB}/audit`);
  const grid = page.getByRole("grid", { name: "Audit log" });
  await expect(grid.getByText(`Archived menu`).first()).toBeVisible();
  await expect(grid.getByText(`Restored menu`).first()).toBeVisible();
  await expect(grid.getByText(m.name).first()).toBeVisible();
  await expect(grid.getByText(/sections replaced/)).toHaveCount(0);
  await expect(grid.getByText(/[0-9a-f]{8}-[0-9a-f]{4}/)).toHaveCount(0);
  await expect(grid.getByText(/seed:/)).toHaveCount(0);
  await shot(page, out("G8-changes.png"));
  await page.getByRole("button", { name: /Any action/ }).click();
  await page.getByRole("option", { name: "Changed menu", exact: true }).click();
  await expect(page).toHaveURL(/[?&]action=menus\.update/);
  await page.reload();
  await expect(page.getByRole("button", { name: /Changed menu/ })).toBeVisible();
  await expect(grid.getByText("Archived menu").first()).toBeVisible();
  await shot(page, out("G8-changes-filtered.png"));
});
