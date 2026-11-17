import type { Page, Request } from "@playwright/test";
import { expect, pairAndSignIn, register, test } from "./fixtures";

/**
 * Fast taps on one tile (live check: 15 quick taps gave about 20 answers of 409 on `POST /v1/orders/{id}/lines`, and
 * the badge showed 7 after 10 taps). This station's adds to one order go one after another with the version the last
 * one left, so its own taps never meet a 409, and the tile counts every tap at once. Taps that come while an add is on
 * its way wait for it and go together in one request (round 8: thirty taps took thirty round trips), and until they land
 * the order panel shows its total and Send as updating rather than a count it knows is behind. Another writer's change
 * is still met with one refetch and an unversioned retry, and no line is lost or doubled.
 */
const CASHIER_PIN = "333333";
const TAPS = 30;

test.use({ viewport: { width: 1180, height: 820 } });

type OrderLines = { data: { id: string; version: number; lines: { id: string; product_id: string; quantity: number; status: string }[] } };

async function startTakeaway(page: Page) {
  await pairAndSignIn(page, CASHIER_PIN);
  await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Floor", exact: true }).click();
  await page.getByRole("button", { name: "Takeaway order", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Menu sections" })).toBeVisible();
}

/** How many lines an add request carried. */
const linesIn = (r: Request) => (JSON.parse(r.postData() ?? "{}") as { lines?: unknown[] }).lines?.length ?? 0;

/** Every add the page sends, and how each was answered. */
function watchAdds(page: Page) {
  const adds: { request: Request; status?: number }[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/v1\/orders\/[^/]+\/lines$/.test(r.url())) adds.push({ request: r });
  });
  page.on("response", (r) => {
    const a = adds.find((x) => x.request === r.request());
    if (a) a.status = r.status();
  });
  return adds;
}

/** The register answers each add 150 ms later than it would, so the taps outrun it as they do on a busy network. */
async function slowAdds(page: Page) {
  await page.route(/\/v1\/orders\/[^/]+\/lines$/, async (route) => {
    if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, 150));
    await route.continue();
  });
}

function orderIdOf(adds: { request: Request }[]) {
  return /\/v1\/orders\/([^/]+)\/lines$/.exec(adds[0]!.request.url())![1]!;
}

test("POS: 30 fast taps on a tile add 30 lines, with no 409 and a count that keeps up with the taps", async ({ page }) => {
  test.setTimeout(300_000);
  await startTakeaway(page);
  const adds = watchAdds(page);
  await slowAdds(page);
  const tile = page.getByRole("button", { name: /^Mee Goreng,/ });
  for (let i = 1; i <= TAPS; i++) {
    await tile.click();
    // The badge counts the tap at once, while earlier adds are still waiting for their answers.
    if (i === 10) {
      await expect(tile).toHaveAccessibleName(/, 10 on the order/, { timeout: 1_000 });
      // The panel does not offer a Send count it knows is behind the taps: Send shows as updating.
      await expect(page.getByRole("button", { name: "Send to kitchen, updating" })).toBeVisible({ timeout: 1_000 });
    }
  }
  await expect(tile).toHaveAccessibleName(new RegExp(`, ${TAPS} on the order`), { timeout: 1_000 });
  await expect(page.getByRole("button", { name: `Send ${TAPS} to kitchen` })).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => adds.every((a) => a.status !== undefined)).toBe(true);
  // Taps that waited went together: fewer requests than taps, every one answered 200 (no 409 to replay; the watch
  // fixture fails on any 409 too), and every tap's line in exactly one of them.
  expect(adds.length).toBeLessThan(TAPS);
  expect(adds.map((a) => a.status)).toEqual(adds.map(() => 200));
  expect(adds.reduce((n, a) => n + linesIn(a.request), 0)).toBe(TAPS);
  const order = await register<OrderLines>("GET", `/v1/orders/${orderIdOf(adds)}`);
  const live = order.data.lines.filter((l) => l.status !== "voided");
  expect(live).toHaveLength(TAPS);
  expect(new Set(live.map((l) => l.id)).size).toBe(TAPS);
  expect(live.reduce((n, l) => n + l.quantity, 0)).toBe(TAPS);
  await expect(tile).toHaveAccessibleName(new RegExp(`, ${TAPS} on the order`));
  // Nothing was sent: cancel the order, so later specs do not meet it among the open ones.
  await register("POST", `/v1/orders/${orderIdOf(adds)}/cancel`, { reason: "End-to-end test" });
});

test("POS: fast taps while another station adds to the same order keep every line once, and say so", async ({ page, watch }) => {
  test.setTimeout(300_000);
  watch.allow({ status: 409, url: /\/v1\/orders\/[^/]+\/lines$/, why: "another writer moved the order on while an add was on the wire; the add is replayed without a version" });
  await startTakeaway(page);
  const adds = watchAdds(page);
  // The 2nd add (the taps that came while the first was on its way) is held on its way to the register until the other
  // writer has landed, so it surely carries a version the other writer has moved on: exactly one 409, which this
  // station did not cause.
  let sentAdds = 0;
  let release = () => {};
  const released = new Promise<void>((r) => (release = r));
  let reached = () => {};
  const heldAdd = new Promise<void>((r) => (reached = r));
  await page.route(/\/v1\/orders\/[^/]+\/lines$/, async (route) => {
    if (route.request().method() === "POST" && ++sentAdds === 2) {
      reached();
      await released;
    }
    await route.continue();
  });
  const products = await register<{ data: { id: string; name: string }[] }>("GET", "/v1/products?limit=50");
  const kopi = products.data.find((p) => p.name === "Kopi")!;
  const tile = page.getByRole("button", { name: /^Mee Goreng,/ });
  // Watched from the start: the notice shows for 4 s, and later notices may take its place.
  const told = page
    .getByText(/^The order changed on another station\. Your (1 new line was|\d+ new lines were) kept$/)
    .waitFor({ timeout: 60_000 })
    .then(
      () => true,
      () => false,
    );
  for (let i = 1; i <= TAPS; i++) await tile.click();
  // The other writer adds a Kopi while this station's 2nd add is on the wire and the rest are queued behind it.
  await heldAdd;
  await register("POST", `/v1/orders/${orderIdOf(adds)}/lines`, { lines: [{ line_id: crypto.randomUUID(), product_id: kopi.id, quantity: 1 }] });
  release();
  await expect(page.getByRole("button", { name: `Send ${TAPS + 1} to kitchen` })).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => adds.every((a) => a.status !== undefined)).toBe(true);
  // Only the add that was on the wire when the other writer landed meets a 409; it is replayed once and announced.
  expect(adds.filter((a) => a.status === 409)).toHaveLength(1);
  expect(adds.filter((a) => a.status === 200).reduce((n, a) => n + linesIn(a.request), 0)).toBe(TAPS);
  expect(await told, "the replayed add is announced").toBe(true);
  const order = await register<OrderLines>("GET", `/v1/orders/${orderIdOf(adds)}`);
  const live = order.data.lines.filter((l) => l.status !== "voided");
  expect(live.filter((l) => l.product_id === kopi.id)).toHaveLength(1);
  expect(live.filter((l) => l.product_id !== kopi.id)).toHaveLength(TAPS);
  expect(new Set(live.map((l) => l.id)).size).toBe(TAPS + 1);
  await expect(tile).toHaveAccessibleName(new RegExp(`, ${TAPS} on the order`));
  // Nothing was sent: cancel the order, so later specs do not meet it among the open ones.
  await register("POST", `/v1/orders/${orderIdOf(adds)}/cancel`, { reason: "End-to-end test" });
});
