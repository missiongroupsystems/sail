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
 *   - heartbeat comment every 20 s keeps proxies from closing idle connections
 */
export function serveStream(c: AppContext, keys: string[], hello: Record<string, unknown>, filter?: (n: Notification) => boolean) {
  return streamSSE(c, async (stream) => {
    let id = 0;
    const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data), id: String(++id) });
    await send("hello", hello);
    const unsubs = keys.map((k) =>
      subscribe(k, (n) => {
        if (filter && !filter(n)) return;
        if (n.kind === "resync") void send("resync", {});
        else if (n.kind === "print_job") void send("job", { job_id: n.job_id, status: n.status, printer_id: n.printer_id });
        else void send("change", { seq: n.seq, type: n.type, outlet_id: n.outlet_id, aggregate_kind: n.aggregate_kind, aggregate_id: n.aggregate_id });
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
