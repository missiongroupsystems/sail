import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { withTransaction } from "../src/db/client.js";
import { seedRulesForMerchant } from "../src/services/pricing-rules.js";
import { requeueStaleClaims } from "../src/services/printing.js";
import { startListener, stopListener } from "../src/sse/listener.js";
import { api, freshDb, readSse, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

let db: TestDb;
let app: App;
let A: SeededMerchant;
let call: ReturnType<typeof api>["call"];
let serverPin: string;
let managerPin: string;
let relayToken: string;
let relay2Token: string;
const ids = { kitchen: randomUUID(), bar: randomUUID(), pass: randomUUID(), backup: randomUUID(), barStation: randomUUID(), station: randomUUID(), relay: randomUUID(), relay2: randomUUID(), laksa: randomUUID(), kopi: randomUUID(), bread: randomUUID(), menu: randomUUID(), link: randomUUID(), area: randomUUID(), table: randomUUID(), reason: randomUUID() };

type Mut = { status: number; body: { data: { id: string; version: number; lines: { id: string; status: string }[]; totals: { total: number } }; warnings: string[]; code?: string; message?: string } };
type Job = { id: string; printer_id: string; kind: string; status: string; text: string; payload?: string; attempts: number; copy_no: number; copies: number; rerouted_to: string | null; age_seconds: number };

beforeAll(async () => {
  db = await freshDb();
  app = buildApp();
  call = api(app).call;
  A = await seedMerchant(db.sql, "Alpha");
  await withTransaction(() => seedRulesForMerchant(A.merchantId));
  const t = A.admin.token;
  await call("POST", "/v1/products", { token: t, body: { id: ids.laksa, name: "Laksa", kitchen_name: "LAKSA", price: 1600, tags: ["kitchen"] } });
  await call("POST", "/v1/products", { token: t, body: { id: ids.kopi, name: "Kopi", price: 180, tags: ["bar"] } });
  await call("POST", "/v1/products", { token: t, body: { id: ids.bread, name: "Bread", price: 300 } }); // no tag → default printer
  await call("POST", "/v1/menus", { token: t, body: { id: ids.menu, brand_id: A.brandId, name: "M", sections: [{ name: "All", items: [ids.laksa, ids.kopi, ids.bread].map((product_id) => ({ product_id })) }] } });
  await call("POST", "/v1/channel-links", { token: t, body: { id: ids.link, channel: "pos", outlet_id: A.outletId, brand_id: A.brandId, menu_id: ids.menu } });
  await call("POST", "/v1/areas", { token: t, body: { id: ids.area, outlet_id: A.outletId, name: "Main" } });
  await call("POST", "/v1/tables", { token: t, body: { id: ids.table, outlet_id: A.outletId, area_id: ids.area, name: "5" } });
  await call("POST", "/v1/void-reasons", { token: t, body: { id: ids.reason, name: "Mistake" } });
  await call("POST", "/v1/stations", { token: t, body: { id: ids.station, outlet_id: A.outletId, brand_id: A.brandId, name: "Floor" } });
  await call("POST", "/v1/stations", { token: t, body: { id: ids.barStation, outlet_id: A.outletId, brand_id: A.brandId, name: "Bar station" } });
  // Printers: Kitchen (kitchen tag), Bar (bar tag, 2 copies), Pass (default, backup for Kitchen), Backup receipt printer unused.
  expect((await call("POST", "/v1/printers", { token: t, body: { id: ids.pass, outlet_id: A.outletId, name: "Pass", ip: "10.0.0.3", is_default_kitchen: true, paper_width: "58mm" } })).status).toBe(201);
  expect((await call("POST", "/v1/printers", { token: t, body: { id: ids.kitchen, outlet_id: A.outletId, name: "Kitchen", ip: "10.0.0.1", include_tags: ["kitchen"], backup_printer_id: ids.pass } })).status).toBe(201);
  expect((await call("POST", "/v1/printers", { token: t, body: { id: ids.bar, outlet_id: A.outletId, name: "Bar", ip: "10.0.0.2", include_tags: ["bar"], copies: 2 } })).status).toBe(201);
  expect((await call("POST", "/v1/printers", { token: t, body: { id: ids.backup, outlet_id: A.outletId, name: "Receipt", ip: "10.0.0.4", role: "receipt" } })).status).toBe(201);
  // Station and relay pairing.
  const code = await call<{ data: { code: string } }>("POST", `/v1/stations/${ids.station}/pairing-code`, { token: t, body: {} });
  const paired = await call<{ data: { station_token: string } }>("POST", "/v1/stations/pair", { body: { code: code.body.data.code, device_label: "iPad" }, idempotencyKey: null });
  const signIn = async (pin: string) => (await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: paired.body.data.station_token, body: { pin } })).body.data.session_token;
  serverPin = await signIn("444444");
  managerPin = await signIn("222222");
  expect((await call("POST", "/v1/relays", { token: t, body: { id: ids.relay, outlet_id: A.outletId, name: "Relay 1" } })).status).toBe(201);
  const rcode = await call<{ data: { code: string } }>("POST", `/v1/relays/${ids.relay}/pairing-code`, { token: t, body: {} });
  const rpaired = await call<{ data: { relay_token: string } }>("POST", "/v1/relays/pair", { body: { code: rcode.body.data.code, version: "test-1" }, idempotencyKey: null });
  expect(rpaired.status).toBe(200);
  relayToken = rpaired.body.data.relay_token;
  // A relay at outlet 2 must not see outlet 1's jobs.
  await call("POST", "/v1/relays", { token: t, body: { id: ids.relay2, outlet_id: A.outlet2Id, name: "Relay 2" } });
  const rcode2 = await call<{ data: { code: string } }>("POST", `/v1/relays/${ids.relay2}/pairing-code`, { token: t, body: {} });
  relay2Token = (await call<{ data: { relay_token: string } }>("POST", "/v1/relays/pair", { body: { code: rcode2.body.data.code }, idempotencyKey: null })).body.data.relay_token;
  await startListener();
});
afterAll(async () => {
  await stopListener();
  await db.drop();
});

let orderId: string;
let laksaLineId: string;

describe("kitchen printing through the relay", () => {
  it("firing creates one job per target printer per copy, routed by tags, with the default printer for untagged items", async () => {
    const o = await call<Mut["body"]>("POST", "/v1/orders", { token: serverPin, body: { order_id: randomUUID(), order_type: "dine_in", table_id: ids.table, pax: 2 } });
    orderId = o.body.data.id;
    laksaLineId = randomUUID();
    const added = await call<Mut["body"]>("POST", `/v1/orders/${orderId}/lines`, { token: serverPin, body: { lines: [{ line_id: laksaLineId, product_id: ids.laksa, quantity: 2, notes: "less spicy", seat_no: 1 }, { line_id: randomUUID(), product_id: ids.kopi, quantity: 1 }, { line_id: randomUUID(), product_id: ids.bread, quantity: 1 }] } });
    expect(added.status).toBe(200);
    const fired = await call<Mut["body"]>("POST", `/v1/orders/${orderId}/fire`, { token: serverPin, body: {} });
    expect(fired.status, JSON.stringify(fired.body)).toBe(200);
    expect(fired.body.warnings).toEqual([]);
    const jobs = await call<{ data: Job[] }>("GET", `/v1/outlets/${A.outletId}/print-jobs?order_id=${orderId}`, { token: serverPin });
    const byPrinter = (pid: string) => jobs.body.data.filter((j) => j.printer_id === pid);
    expect(byPrinter(ids.kitchen)).toHaveLength(1);
    expect(byPrinter(ids.bar)).toHaveLength(2); // 2 copies
    expect(byPrinter(ids.pass)).toHaveLength(1); // bread → default
    expect(byPrinter(ids.pass)[0]!.text).toMatch(/Bread/);
    expect(byPrinter(ids.pass)[0]!.text).not.toMatch(/LAKSA|Kopi/); // the fallback printer takes only unrouted items
    expect(byPrinter(ids.backup)).toHaveLength(0);
    const kitchenJob = byPrinter(ids.kitchen)[0]!;
    expect(kitchenJob.text).toMatch(/LAKSA/);
    expect(kitchenJob.text).toMatch(/LESS SPICY/i);
    expect(kitchenJob.text).toMatch(/S1/);
    expect(kitchenJob.text).toContain(kitchenJob.id.slice(0, 8));
    expect(kitchenJob.text).not.toMatch(/Kopi/);
    expect(jobs.body.data.every((j) => j.status === "queued")).toBe(true);
  });

  it("the relay sees only its outlet's jobs, claims, acks, and the POS sees status changes on the outlet stream", async () => {
    const other = await call<{ data: Job[] }>("GET", `/v1/relays/${ids.relay2}/jobs`, { token: relay2Token });
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    expect(other.body.data).toEqual([]);
    const wrongRelay = await call("GET", `/v1/relays/${ids.relay}/jobs`, { token: relay2Token });
    expect(wrongRelay.status).toBe(404);
    const staffDenied = await call("GET", `/v1/relays/${ids.relay}/jobs`, { token: A.admin.token });
    expect(staffDenied.status).toBe(403);

    const mine = await call<{ data: Job[] }>("GET", `/v1/relays/${ids.relay}/jobs`, { token: relayToken });
    expect(mine.body.data).toHaveLength(4);
    expect(mine.body.data[0]!.payload).toBeTruthy();
    const bytes = Buffer.from(mine.body.data[0]!.payload!, "base64");
    expect([bytes[0], bytes[1]]).toEqual([0x1b, 0x40]); // ESC @

    const posStream = await app.request(`/v1/outlets/${A.outletId}/stream`, { headers: { authorization: `Bearer ${serverPin}` } });
    const pending = readSse(posStream, 5, 5000);
    await new Promise((r) => setTimeout(r, 100));
    const job = mine.body.data.find((j) => j.printer_id === ids.kitchen)!;
    const claimed = await call<{ data: Job }>("POST", `/v1/relays/${ids.relay}/jobs/${job.id}/claim`, { token: relayToken, body: {} });
    expect(claimed.status).toBe(200);
    expect(claimed.body.data.status).toBe("claimed");
    const again = await call("POST", `/v1/relays/${ids.relay}/jobs/${job.id}/claim`, { token: relayToken, body: {} });
    expect(again.status).toBe(200); // idempotent for the same relay
    const acked = await call<{ data: Job }>("POST", `/v1/relays/${ids.relay}/jobs/${job.id}/ack`, { token: relayToken, body: { ok: true } });
    expect(acked.body.data.status).toBe("printed");
    const got = await pending;
    // Each job update also appends an event (print_job.claimed / printed), so the stream carries `job` and `change` pairs.
    expect(got[0]!.event).toBe("hello");
    expect(got.filter((e) => e.event === "job").map((e) => (e.data as { status: string }).status)).toEqual(["claimed", "printed"]);
    const remaining = await call<{ data: Job[] }>("GET", `/v1/relays/${ids.relay}/jobs`, { token: relayToken });
    expect(remaining.body.data).toHaveLength(3);
  });

  it("a failed job is reported, late jobs are listed, and staff reroute to the backup printer", async () => {
    const queued = await call<{ data: Job[] }>("GET", `/v1/relays/${ids.relay}/jobs?status=queued`, { token: relayToken });
    const barJobs = queued.body.data.filter((j) => j.printer_id === ids.bar);
    const first = barJobs[0]!;
    await call("POST", `/v1/relays/${ids.relay}/jobs/${first.id}/claim`, { token: relayToken, body: {} });
    const failed = await call<{ data: Job }>("POST", `/v1/relays/${ids.relay}/jobs/${first.id}/ack`, { token: relayToken, body: { ok: false, error: "Paper out" } });
    expect(failed.body.data.status).toBe("failed");
    // Age the jobs so they count as late.
    await db.sql`update print_jobs set created_at = created_at - interval '15 seconds' where order_id = ${orderId}`;
    const late = await call<{ data: Job[] }>("GET", `/v1/outlets/${A.outletId}/print-jobs?late=true`, { token: serverPin });
    expect(late.body.data.map((j) => j.status).sort()).toEqual(["failed", "queued", "queued"]);
    // Reroute the bar jobs: Bar has no backup → invariant; give an explicit target.
    const noBackup = await call<{ code: string }>("POST", "/v1/print-jobs/reroute", { token: serverPin, body: { job_ids: barJobs.map((j) => j.id) } });
    expect(noBackup.status).toBe(422);
    const rerouted = await call<{ data: { id: string; printer_id: string }[] }>("POST", "/v1/print-jobs/reroute", { token: serverPin, body: { job_ids: barJobs.map((j) => j.id), printer_id: ids.pass } });
    expect(rerouted.status).toBe(201);
    expect(rerouted.body.data).toHaveLength(2);
    expect(rerouted.body.data.every((j) => j.printer_id === ids.pass)).toBe(true);
    const originals = await call<{ data: Job[] }>("GET", `/v1/outlets/${A.outletId}/print-jobs?printer_id=${ids.bar}`, { token: serverPin });
    expect(originals.body.data.every((j) => j.status === "rerouted" && j.rerouted_to)).toBe(true);
    const toReceipt = await call<{ code: string }>("POST", "/v1/print-jobs/reroute", { token: serverPin, body: { job_ids: [rerouted.body.data[0]!.id], printer_id: ids.backup } });
    expect(toReceipt.status).toBe(422); // role mismatch kitchen → receipt
  });

  it("stale claims are re-queued by the worker; printed jobs cannot be rerouted", async () => {
    const queued = await call<{ data: Job[] }>("GET", `/v1/relays/${ids.relay}/jobs?status=queued`, { token: relayToken });
    const job = queued.body.data[0]!;
    await call("POST", `/v1/relays/${ids.relay}/jobs/${job.id}/claim`, { token: relayToken, body: {} });
    expect(await withTransaction(() => requeueStaleClaims(new Date()))).toEqual([]);
    const requeued = await withTransaction(() => requeueStaleClaims(new Date(Date.now() + 120_000)));
    expect(requeued).toEqual([job.id]);
    const printedJob = (await call<{ data: Job[] }>("GET", `/v1/outlets/${A.outletId}/print-jobs?status=printed`, { token: serverPin })).body.data[0]!;
    expect((await call("POST", "/v1/print-jobs/reroute", { token: serverPin, body: { job_ids: [printedJob.id], printer_id: ids.pass } })).status).toBe(409);
  });

  it("reprint creates a REPRINT ticket on the same printer; a void after firing prints a VOID ticket to the printer that got the item", async () => {
    const printedJob = (await call<{ data: Job[] }>("GET", `/v1/outlets/${A.outletId}/print-jobs?status=printed`, { token: serverPin })).body.data[0]!;
    const reprint = await call<{ data: { id: string; printer_id: string; kind: string }[] }>("POST", `/v1/print-jobs/${printedJob.id}/reprint`, { token: serverPin, body: {} });
    expect(reprint.status).toBe(201);
    expect(reprint.body.data[0]).toMatchObject({ printer_id: ids.kitchen, kind: "reprint" });
    const reprintJob = (await call<{ data: Job[] }>("GET", `/v1/outlets/${A.outletId}/print-jobs?status=queued&printer_id=${ids.kitchen}`, { token: serverPin })).body.data.find((j) => j.kind === "reprint")!;
    expect(reprintJob.text).toMatch(/REPRINT/);

    const voided = await call<Mut["body"]>("POST", `/v1/orders/${orderId}/lines/${laksaLineId}/void`, { token: managerPin, body: { reason_id: ids.reason, quantity: 1 } });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    const voidJobs = (await call<{ data: Job[] }>("GET", `/v1/outlets/${A.outletId}/print-jobs?order_id=${orderId}`, { token: serverPin })).body.data.filter((j) => j.kind === "void");
    expect(voidJobs.map((j) => j.printer_id), JSON.stringify(voidJobs.map((j) => [j.printer_id, j.text.slice(0, 120)]))).toEqual([ids.kitchen]);
    expect(voidJobs[0]!.text).toMatch(/VOID/);
    expect(voidJobs[0]!.text).toMatch(/1\s+LAKSA|LAKSA/);
  });

  it("test prints need Admin; heartbeats record last seen and printer status; a relay stream says hello with the queue size", async () => {
    expect((await call("POST", `/v1/printers/${ids.kitchen}/test`, { token: A.manager.token, body: {} })).status).toBe(403);
    const test = await call<{ data: { kind: string }[] }>("POST", `/v1/printers/${ids.kitchen}/test`, { token: A.admin.token, body: {} });
    expect(test.status).toBe(201);
    expect(test.body.data[0]!.kind).toBe("test");
    const hb = await call("POST", `/v1/relays/${ids.relay}/heartbeat`, { token: relayToken, body: { version: "test-2", printer_status: { [ids.kitchen]: { ok: false, checked_at: new Date().toISOString(), error: "unreachable" } } } });
    expect(hb.status).toBe(200);
    const relays = await call<{ data: { id: string; online: boolean; version: string; printer_status: Record<string, { ok: boolean }> }[] }>("GET", `/v1/relays?outlet_id=${A.outletId}`, { token: A.admin.token });
    const r = relays.body.data.find((x) => x.id === ids.relay)!;
    expect(r.online).toBe(true);
    expect(r.version).toBe("test-2");
    expect(r.printer_status[ids.kitchen]!.ok).toBe(false);
    const stream = await app.request(`/v1/relays/${ids.relay}/stream`, { headers: { authorization: `Bearer ${relayToken}` } });
    expect(stream.status).toBe(200);
    const [hello] = await readSse(stream, 1, 3000);
    expect(hello!.event).toBe("hello");
    expect((hello!.data as { queued: number }).queued).toBeGreaterThan(0);
  });

  it("the relay package's loop drives the API end to end (pair, catch up, claim, send to a fake printer, ack)", async () => {
    const net = await import("node:net");
    const received: Buffer[] = [];
    const fake = net.createServer((s) => s.on("data", (b) => received.push(b)));
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
    const port = (fake.address() as import("node:net").AddressInfo).port;
    // Point the Pass printer at the fake printer and queue a job for it.
    await call("PATCH", `/v1/printers/${ids.pass}`, { token: A.admin.token, body: { ip: "127.0.0.1", port, supports_status: false } });
    await db.sql`update print_jobs set status = 'failed' where status = 'queued' and printer_id <> ${ids.pass}`; // park the rest
    await db.sql`update print_jobs set status = 'queued', claimed_by = null, claimed_at = null where status = 'claimed'`;
    const relay3 = randomUUID();
    await call("POST", "/v1/relays", { token: A.admin.token, body: { id: relay3, outlet_id: A.outletId, name: "Relay 3" } });
    const code = (await call<{ data: { code: string } }>("POST", `/v1/relays/${relay3}/pairing-code`, { token: A.admin.token, body: {} })).body.data.code;
    const { Relay } = await import("../../relay/src/relay.js");
    const stateFile = `/tmp/claude-1003/-home-mission-dev-missionsystems-sail/db18c92c-b4d7-4c0e-a7d9-a9c5864feb4c/scratchpad/relay-${randomUUID()}.json`;
    const fetchImpl: typeof fetch = async (input, init) => app.request(typeof input === "string" ? input.replace("http://sail", "") : (input as Request), init);
    const relay = new Relay({ apiUrl: "http://sail", stateFile, pairingCode: code, version: "test", log: () => {}, fetchImpl, maxAttempts: 1 });
    await relay.start();
    const deadline = Date.now() + 8000;
    let printedAll = false;
    while (Date.now() < deadline) {
      const q = await call<{ data: Job[] }>("GET", `/v1/outlets/${A.outletId}/print-jobs?printer_id=${ids.pass}&status=queued,claimed`, { token: serverPin });
      if (q.body.data.length === 0) {
        printedAll = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    await relay.stop();
    fake.close();
    expect(printedAll).toBe(true);
    expect(Buffer.concat(received).length).toBeGreaterThan(20);
    const printed = await call<{ data: Job[] }>("GET", `/v1/outlets/${A.outletId}/print-jobs?printer_id=${ids.pass}&status=printed`, { token: serverPin });
    expect(printed.body.data.length).toBeGreaterThanOrEqual(3);
  });
});
