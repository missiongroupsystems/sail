import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Relay, wantsCatchUp } from "./relay.js";

/** Count sends in flight per printer (by port) around the real transport, to prove one-at-a-time per printer. */
const inFlightByPort = new Map<number, number>();
const maxInFlightByPort = new Map<number, number>();
let maxInFlightTotal = 0;
vi.mock("./printer.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./printer.js")>();
  const sendJob: typeof real.sendJob = async (target, bytes, opts) => {
    const n = (inFlightByPort.get(target.port) ?? 0) + 1;
    inFlightByPort.set(target.port, n);
    maxInFlightByPort.set(target.port, Math.max(maxInFlightByPort.get(target.port) ?? 0, n));
    maxInFlightTotal = Math.max(maxInFlightTotal, [...inFlightByPort.values()].reduce((a, b) => a + b, 0));
    try {
      await new Promise((r) => setTimeout(r, 15)); // let overlapping sends, if any, overlap
      return await real.sendJob(target, bytes, opts);
    } finally {
      inFlightByPort.set(target.port, (inFlightByPort.get(target.port) ?? 1) - 1);
    }
  };
  return { ...real, sendJob };
});

/**
 * The relay loop against an in-memory register (the routes in
 * server/src/routes/printing.ts, reduced to their contract) and fake TCP
 * printers. Nothing here renders or parses tickets: payloads are opaque bytes.
 */
type Job = { id: string; printer_id: string; payload: string; status: string; attempts: number; claimed_by: string | null };
type Ack = { job_id: string; ok: boolean; error?: string; requeue?: boolean };

class FakeRegister {
  readonly relayId = "11111111-1111-4111-8111-111111111111";
  readonly token = "relay-token-secret";
  jobs: Job[] = [];
  acks: Ack[] = [];
  heartbeats: unknown[] = [];
  claims = 0;
  jobsFetches = 0;
  /** Fail the next N acks with 503 (network blip). */
  failAcks = 0;
  printers: { id: string; name: string; ip: string; port: number; supports_status: boolean }[] = [];
  private streams = new Set<ReadableStreamDefaultController<Uint8Array>>();

  constructor() {
    this.fetch = this.fetch.bind(this);
  }

  addJob(id: string, printerId: string, payload: string) {
    this.jobs.push({ id, printer_id: printerId, payload: Buffer.from(payload).toString("base64"), status: "queued", attempts: 0, claimed_by: null });
  }

  /** Push an SSE frame to every connected stream. */
  signal(event: string, data: unknown) {
    const frame = new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const c of this.streams) c.enqueue(frame);
  }

  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const path = url.pathname;
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (path === "/v1/relays/pair") return json(200, { data: { relay_token: this.token, relay: { id: this.relayId, outlet_id: "outlet" } } });
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    if (auth !== `Bearer ${this.token}`) return json(401, { code: "unauthenticated", message: "no" });
    const base = `/v1/relays/${this.relayId}`;
    if (path === `${base}/printers`) return json(200, { data: this.printers, next_cursor: null });
    if (path === `${base}/heartbeat`) {
      this.heartbeats.push(JSON.parse(String(init?.body)));
      return json(200, { data: { ok: true, server_time: new Date().toISOString() } });
    }
    if (path === `${base}/jobs`) {
      this.jobsFetches++;
      return json(200, { data: this.jobs.filter((j) => j.status === "queued" || (j.status === "claimed" && j.claimed_by === this.relayId)), next_cursor: null });
    }
    if (path === `${base}/stream`) {
      const streams = this.streams;
      let ctrl: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          ctrl = c;
          streams.add(c);
          c.enqueue(new TextEncoder().encode(`event: hello\ndata: {"queued":0}\n\n`));
        },
        cancel() {
          streams.delete(ctrl);
        },
      });
      init?.signal?.addEventListener("abort", () => {
        streams.delete(ctrl);
        try {
          ctrl.close();
        } catch {
          /* already closed */
        }
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const m = path.match(new RegExp(`^${base}/jobs/([^/]+)/(claim|ack)$`));
    if (m) {
      const job = this.jobs.find((j) => j.id === m[1]);
      if (!job) return json(404, { code: "not_found", message: "no job" });
      if (m[2] === "claim") {
        this.claims++;
        if (job.status === "claimed" && job.claimed_by === this.relayId) return json(200, { data: job });
        if (job.status !== "queued") return json(409, { code: "state_conflict", message: `Job is ${job.status}` });
        Object.assign(job, { status: "claimed", claimed_by: this.relayId, attempts: job.attempts + 1 });
        return json(200, { data: job });
      }
      if (this.failAcks > 0) {
        this.failAcks--;
        return json(503, { code: "overloaded", message: "busy" });
      }
      if (job.status !== "claimed" || job.claimed_by !== this.relayId) return json(409, { code: "state_conflict", message: `Job is ${job.status}` });
      const b = JSON.parse(String(init?.body)) as { ok: boolean; error?: string; requeue?: boolean };
      this.acks.push({ job_id: job.id, ...b });
      job.status = b.ok ? "printed" : b.requeue ? "queued" : "failed";
      if (job.status === "queued") job.claimed_by = null;
      this.signal("job", { job_id: job.id, status: job.status, printer_id: job.printer_id });
      return json(200, { data: job });
    }
    return json(404, { code: "not_found", message: path });
  }
}

/** A fake ESC/POS printer that records what it receives, in order. */
async function fakePrinter() {
  const received: string[] = [];
  const server = net.createServer((socket) => {
    socket.on("data", (b) => received.push(b.toString()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return { port, received, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function until(cond: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const dir = mkdtempSync(join(tmpdir(), "sail-relay-test-"));
const stateFile = () => join(dir, `${crypto.randomUUID()}.json`);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function makeRelay(reg: FakeRegister, extra: Partial<ConstructorParameters<typeof Relay>[0]> = {}) {
  const logs: { level: string; msg: string; extra?: Record<string, unknown> }[] = [];
  const relay = new Relay({ apiUrl: "http://register", stateFile: stateFile(), pairingCode: "123456", version: "test", fetchImpl: reg.fetch, retryDelayMs: () => 20, log: (level, msg, extra) => logs.push({ level, msg, extra }), ...extra });
  cleanups.push(() => relay.stop());
  return { relay, logs };
}

describe("relay loop", () => {
  it("pairs, catches up, claims, prints each printer's jobs in order one at a time (printers in parallel), and acks printed", async () => {
    const reg = new FakeRegister();
    const kitchen = await fakePrinter();
    const bar = await fakePrinter();
    cleanups.push(kitchen.close, bar.close);
    reg.printers = [
      { id: "p1", name: "Kitchen", ip: "127.0.0.1", port: kitchen.port, supports_status: false },
      { id: "p2", name: "Bar", ip: "127.0.0.1", port: bar.port, supports_status: false },
    ];
    for (const n of [1, 2, 3, 4, 5]) reg.addJob(`job-${n}`, "p1", `TICKET ${n}`);
    for (const n of [1, 2, 3]) reg.addJob(`bar-${n}`, "p2", `DRINKS ${n}`);
    const { relay } = makeRelay(reg);
    await relay.start();
    // The fake register answers in-process, so acks can land before the event loop lets the fake printers read: wait for both.
    await until(() => reg.acks.length === 8 && kitchen.received.length === 5 && bar.received.length === 3);
    expect(reg.acks.every((a) => a.ok)).toBe(true);
    expect(reg.jobs.every((j) => j.status === "printed")).toBe(true);
    expect(kitchen.received).toEqual(["TICKET 1", "TICKET 2", "TICKET 3", "TICKET 4", "TICKET 5"]);
    expect(bar.received).toEqual(["DRINKS 1", "DRINKS 2", "DRINKS 3"]);
    expect(maxInFlightByPort.get(kitchen.port)).toBe(1);
    expect(maxInFlightByPort.get(bar.port)).toBe(1);
    expect(maxInFlightTotal).toBe(2);
    expect(reg.claims).toBe(8);
    await until(() => reg.heartbeats.length >= 1);
    expect((reg.heartbeats[0] as { printer_status: Record<string, { ok: boolean }> }).printer_status.p1!.ok).toBe(true);
  });

  it("gives up after maxAttempts on an unreachable printer and acks failed, not requeued", async () => {
    const reg = new FakeRegister();
    reg.printers = [{ id: "p1", name: "Kitchen", ip: "127.0.0.1", port: await closedPort(), supports_status: false }];
    reg.addJob("job-1", "p1", "TICKET");
    const { relay, logs } = makeRelay(reg, { maxAttempts: 2 });
    await relay.start();
    await until(() => reg.acks.length === 1);
    expect(reg.acks[0]).toMatchObject({ job_id: "job-1", ok: false });
    expect(reg.acks[0]!.requeue).toBeUndefined();
    expect(reg.acks[0]!.error).toMatch(/Cannot reach the printer/);
    expect(reg.jobs[0]!.status).toBe("failed");
    expect(logs.filter((l) => l.msg === "print attempt failed")).toHaveLength(2);
    expect(JSON.stringify(logs)).not.toContain(reg.token);
  });

  it("acks failed with the printer's reason when the status query reports a problem", async () => {
    const reg = new FakeRegister();
    const server = net.createServer((socket) => {
      socket.on("data", (buf) => {
        if (buf.length === 3 && buf[0] === 0x10 && buf[1] === 0x04) socket.write(Buffer.from([buf[2] === 0x01 ? 0x12 | 0x20 : 0x12]));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    reg.printers = [{ id: "p1", name: "Kitchen", ip: "127.0.0.1", port: (server.address() as net.AddressInfo).port, supports_status: true }];
    reg.addJob("job-1", "p1", "TICKET");
    const { relay } = makeRelay(reg, { maxAttempts: 1 });
    await relay.start();
    await until(() => reg.acks.length === 1);
    expect(reg.acks[0]).toMatchObject({ ok: false, error: "Cover open" });
  });

  it("hands a claimed, unsent job back (requeue) when stopped mid-retry", async () => {
    const reg = new FakeRegister();
    reg.printers = [{ id: "p1", name: "Kitchen", ip: "127.0.0.1", port: await closedPort(), supports_status: false }];
    reg.addJob("job-1", "p1", "TICKET");
    const { relay } = makeRelay(reg, { maxAttempts: 5, retryDelayMs: () => 300 });
    await relay.start();
    await until(() => reg.claims === 1);
    await relay.stop();
    expect(reg.acks).toHaveLength(1);
    expect(reg.acks[0]).toMatchObject({ job_id: "job-1", ok: false, requeue: true });
    expect(reg.jobs[0]!.status).toBe("queued");
  });

  it("retries the ack after a 5xx so a printed ticket is not left as a stale claim", async () => {
    const reg = new FakeRegister();
    const printer = await fakePrinter();
    cleanups.push(printer.close);
    reg.printers = [{ id: "p1", name: "Kitchen", ip: "127.0.0.1", port: printer.port, supports_status: false }];
    reg.addJob("job-1", "p1", "TICKET");
    reg.failAcks = 1;
    const { relay } = makeRelay(reg);
    await relay.start();
    await until(() => reg.acks.length === 1 && printer.received.length === 1, 8000);
    expect(reg.acks[0]).toMatchObject({ ok: true });
    expect(printer.received).toEqual(["TICKET"]);
  });

  it("catches up on a `job` signal for a newly queued job, and on a stale claim of its own", async () => {
    const reg = new FakeRegister();
    const printer = await fakePrinter();
    cleanups.push(printer.close);
    reg.printers = [{ id: "p1", name: "Kitchen", ip: "127.0.0.1", port: printer.port, supports_status: false }];
    // A job this relay claimed before a restart: served by the catch-up as already claimed, so no second claim.
    reg.addJob("job-0", "p1", "OLD");
    Object.assign(reg.jobs[0]!, { status: "claimed", claimed_by: reg.relayId, attempts: 1 });
    const { relay } = makeRelay(reg);
    await relay.start();
    await until(() => reg.acks.length === 1);
    expect(reg.claims).toBe(0);
    const fetchesBefore = reg.jobsFetches;
    reg.addJob("job-1", "p1", "NEW");
    reg.signal("job", { job_id: "job-1", status: "queued", printer_id: "p1" });
    await until(() => reg.acks.length === 2 && printer.received.length === 2);
    expect(printer.received).toEqual(["OLD", "NEW"]);
    expect(reg.jobsFetches).toBeGreaterThan(fetchesBefore);
    // Our own ack signals (printed) do not cost a round trip.
    const after = reg.jobsFetches;
    reg.signal("job", { job_id: "job-1", status: "printed", printer_id: "p1" });
    await new Promise((r) => setTimeout(r, 100));
    expect(reg.jobsFetches).toBe(after);
  });
});

describe("wantsCatchUp", () => {
  it("fetches on hello, resync and queued jobs; ignores other job statuses and change frames", () => {
    expect(wantsCatchUp('event: hello\ndata: {"queued":2}')).toBe(true);
    expect(wantsCatchUp("event: resync\ndata: {}")).toBe(true);
    expect(wantsCatchUp('event: job\ndata: {"job_id":"x","status":"queued"}')).toBe(true);
    expect(wantsCatchUp('event: job\ndata: {"job_id":"x","status":"printed"}')).toBe(false);
    expect(wantsCatchUp('event: job\ndata: {"job_id":"x","status":"claimed"}')).toBe(false);
    expect(wantsCatchUp('event: change\ndata: {"seq":1}')).toBe(false);
    expect(wantsCatchUp("event: job\ndata: not json")).toBe(true);
    expect(wantsCatchUp("event: job")).toBe(true);
  });
});
