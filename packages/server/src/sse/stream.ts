import { streamSSE } from "hono/streaming";
import type { AppContext } from "../lib/context.js";
import { subscribe, type Notification } from "./listener.js";

const HEARTBEAT_MS = 20_000;

/**
 * Serve one SSE stream. The stream only signals; the event log is the source
 * of truth. Events sent:
 *   - `hello`   { seq }         the latest sequence at connect, so the client can catch up
 *   - `change`  { seq, type }   a new event exists
 *   - `job`     { job_id, status } a print job changed (relays)
 *   - `resync`  {}              the LISTEN connection was re-established; catch up now
 *   - `ended`   { reason? }     the stream's session has ended (`ended` below); the stream closes after it
 *   - heartbeat comment every 20 s keeps proxies from closing idle connections
 */
export function serveStream(c: AppContext, keys: string[], hello: Record<string, unknown>, filter?: (n: Notification) => boolean, ended?: () => Promise<Record<string, unknown> | null>) {
  return streamSSE(c, async (stream) => {
    let id = 0;
    const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data), id: String(++id) });
    await send("hello", hello);
    // With `ended`, each change is checked against the session first (in order of arrival): once it has ended, the
    // client hears `ended` instead of a change it could only answer with a request the register would refuse.
    let queue: Promise<void> = Promise.resolve();
    let over = false;
    const relay = async (n: Notification) => {
      if (over) return;
      if (n.kind === "print_job") return void (await send("job", { job_id: n.job_id, status: n.status, printer_id: n.printer_id }));
      // A resync makes the client refetch too, so it is checked like a change.
      const end = ended ? await ended().catch(() => null) : null;
      if (end) {
        over = true;
        await send("ended", end);
        await stream.close();
        return;
      }
      if (n.kind === "resync") return void (await send("resync", {}));
      await send("change", { seq: n.seq, type: n.type, outlet_id: n.outlet_id, aggregate_kind: n.aggregate_kind, aggregate_id: n.aggregate_id });
    };
    const unsubs = keys.map((k) =>
      subscribe(k, (n) => {
        if (filter && !filter(n)) return;
        queue = queue.then(() => relay(n)).catch(() => undefined);
      }),
    );
    const heartbeat = setInterval(() => void stream.write(`: ping ${Date.now()}\n\n`), HEARTBEAT_MS);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      for (const u of unsubs) u();
    };
    stream.onAbort(close);
    c.req.raw.signal.addEventListener("abort", close);
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (closed || stream.aborted || stream.closed) {
          clearInterval(check);
          close();
          resolve();
        }
      }, 250);
    });
  });
}
