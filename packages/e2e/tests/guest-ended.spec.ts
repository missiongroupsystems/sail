import { devLocal, expect, GUEST, register, shot, test } from "./fixtures";

/**
 * Paying the table ends its guest sessions. The phone already said "This table session has ended.", but it learned
 * so by refetching the order with the ended session and being refused (live check: a 401 on `GET /v1/guest/order`
 * in the console). The register's stream now tells the phone the session ended, so it sends nothing more with it.
 * The watch fixture fails the test on any 401 and on any console error.
 */
test("paying the table ends the phone's session without a refused request", async ({ browser }) => {
  test.setTimeout(300_000);
  const { outletId } = devLocal();
  const links = await register<{ data: { id: string; channel: string; outlet_id: string }[] }>("GET", "/v1/channel-links");
  const link = links.data.find((l) => l.channel === "scan_to_order" && l.outlet_id === outletId)!;
  await register("PATCH", `/v1/channel-links/${link.id}`, { open_on_first_scan: true });
  const tenders = await register<{ data: { id: string; is_cash: boolean; provider?: string | null }[] }>("GET", "/v1/tender-types");
  const byHand = tenders.data.find((t) => !t.is_cash && !t.provider)!;
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  // `watch` is only attached to the default page; the phone is watched by hand so this test owns its own checks.
  const problems: string[] = [];
  const guestCalls: string[] = [];
  phone.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  phone.on("response", (r) => {
    if (r.url().includes("/v1/guest/")) guestCalls.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
    if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
  });
  const floor = await register<{ data: { tables: { id: string; order: unknown }[] } }>("GET", `/v1/outlets/${outletId}/floor`);
  const table = floor.data.tables.find((t) => !t.order)!;
  const qr = await register<{ data: { url: string } }>("POST", `/v1/tables/${table.id}/qr/rotate`, {});
  await phone.goto(`${GUEST}/t/${qr.data.url.split("/t/")[1]!}`);
  await phone.getByRole("button", { name: /^Kopi,/ }).click();
  await phone.getByRole("dialog", { name: "Kopi" }).getByRole("button", { name: /^Add to order/ }).click();
  await phone.getByRole("button", { name: /^View your order, 1 item/ }).click();
  await phone.getByRole("button", { name: /^Send/ }).first().click();
  await expect(phone.getByRole("heading", { name: "Order sent" })).toBeVisible();

  const seated = await register<{ data: { tables: { id: string; order: { id: string } | null }[] } }>("GET", `/v1/outlets/${outletId}/floor`);
  const orderId = seated.data.tables.find((t) => t.id === table.id)!.order!.id;
  const rounds = await register<{ data: { id: string; order_id: string }[] }>("GET", `/v1/outlets/${outletId}/rounds?status=pending`);
  const round = rounds.data.find((r) => r.order_id === orderId);
  if (round) await register("POST", `/v1/rounds/${round.id}/accept`, {});
  // The phone is live on the order's stream before the table is paid.
  await expect.poll(() => guestCalls.some((c) => c.startsWith("200 GET /v1/guest/stream"))).toBe(true);
  const order = await register<{ data: { balance: number; checks: { id: string }[] } }>("GET", `/v1/orders/${orderId}`);
  await register("POST", `/v1/checks/${order.data.checks[0]!.id}/payments`, { payment_id: crypto.randomUUID(), tender_type_id: byHand.id, amount: order.data.balance });
  await register("POST", `/v1/orders/${orderId}/complete`, {}).catch(() => undefined);
  const after = await register<{ data: { status: string } }>("GET", `/v1/orders/${orderId}`);
  expect(after.data.status).toBe("completed");

  await expect(phone.getByText("This table session has ended.")).toBeVisible({ timeout: 30_000 });
  await shot(phone, test.info().outputPath("phone-ended.png"));
  // Long enough for any poll or refetch that was still going to run with the ended session.
  await phone.waitForTimeout(5_000);
  expect(problems, guestCalls.join("\n")).toEqual([]);
  await phone.close();
});
