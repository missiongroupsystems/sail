import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeType, GuestStream } from "./stream";

describe("changeType", () => {
  it("reads the event type of a change frame, so stock changes refetch the menu (final2 C-2)", () => {
    expect(changeType(JSON.stringify({ seq: 4, type: "stock.sold_out", aggregate_kind: "product" }))).toBe("stock.sold_out");
    expect(changeType(JSON.stringify({ seq: 5, type: "round.accepted" }))).toBe("round.accepted");
    expect(changeType("not json")).toBe("");
    expect(changeType("null")).toBe("");
  });
});

/* ---- The held stream of a paid phone (review 5 W1) ---- */

type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();
const target = { addEventListener: (t: string, l: Listener) => (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(l), removeEventListener: (t: string, l: Listener) => listeners.get(t)?.delete(l) };
const fire = (t: string) => listeners.get(t)?.forEach((l) => l());

/** A server stream the test writes frames into, and can drop. */
function sse() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) });
  const enc = new TextEncoder();
  return {
    res: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    send: (event: string, data: unknown) => ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
    drop: () => ctrl.error(new Error("dropped")),
  };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("GuestStream held (paid)", () => {
  let streams: ReturnType<typeof sse>[];
  let calls: number;
  beforeEach(() => {
    listeners.clear();
    streams = [];
    calls = 0;
    vi.stubGlobal("document", { ...target, visibilityState: "visible" });
    vi.stubGlobal("window", target);
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      const s = sse();
      streams.push(s);
      return s.res;
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const make = (held: boolean) => {
    const ev = { change: 0, resumed: 0, ended: [] as (Record<string, unknown> | undefined)[] };
    const stream = new GuestStream({ baseUrl: "http://x", getToken: () => "t", onChange: () => ev.change++, onResumed: () => ev.resumed++, onUnauthenticated: (d) => ev.ended.push(d), held });
    return { stream, ev };
  };

  it("opened on the paid screen: the register's `ended` changes nothing, its `hello` (open again) brings the phone back", async () => {
    const { stream, ev } = make(true);
    stream.start();
    await tick();
    streams[0]!.send("ended", { reason: "order_paid" });
    await tick(200);
    expect(ev).toEqual({ change: 0, resumed: 0, ended: [] });
    // Reconnected after a drop (a locked phone shown again), and the order was reopened meanwhile.
    streams[0]!.drop();
    await tick();
    fire("visibilitychange");
    await tick();
    expect(calls).toBe(2);
    streams[1]!.send("hello", { order_id: "o" });
    await tick(200);
    expect(ev.resumed).toBe(1);
    expect(ev.change).toBe(1);
    stream.stop();
  });

  it("held, a void comes as a change: back on the order; a later rotation while held is said as its own end", async () => {
    const { stream, ev } = make(false);
    stream.start();
    await tick();
    streams[0]!.send("hello", {});
    await tick(200);
    streams[0]!.send("ended", { reason: "order_paid" });
    await tick(200);
    expect(ev.ended).toEqual([{ reason: "order_paid" }]);
    const before = ev.change;
    streams[0]!.send("change", { type: "payment.voided" });
    await tick(200);
    expect(ev.resumed).toBe(1);
    expect(ev.change).toBe(before + 1);
    // Paid again, then the table's code is rotated.
    streams[0]!.send("ended", { reason: "order_paid" });
    streams[0]!.send("ended", { reason: "code_rotated" });
    await tick(50);
    expect(ev.ended.at(-1)).toEqual({ reason: "code_rotated" });
    expect(stream.listening).toBe(false);
  });

  it("held, a stock change refetches nothing and does not bring the phone back", async () => {
    const { stream, ev } = make(true);
    stream.start();
    await tick();
    streams[0]!.send("ended", { reason: "order_paid" });
    streams[0]!.send("change", { type: "stock.sold_out" });
    await tick(200);
    expect(ev).toEqual({ change: 0, resumed: 0, ended: [] });
    stream.stop();
  });
});
