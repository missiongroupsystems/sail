import { streamSSE } from "hono/streaming";
import type { AppContext } from "../lib/context.js";
import { subscribe, type Notification } from "./listener.js";

const HEARTBEAT_MS = 20_000;

/**
 * Serve one SSE stream. The stream only signals; the event log is the source
 * of truth. Events sent:
 *   - `hello`   { seq }         the latest sequence at connect, so the client can catch up (`ended` instead, when the
 *                               session has already ended)
 *   - `change`  { seq, type }   a new event exists
 *   - `job`     { job_id, status } a print job changed (relays)
 *   - `resync`  {}              the LISTEN connection was re-established; catch up now
 *   - `ended`   { reason? }     the stream's session has ended (`ended` below); the stream closes after it, except
 *                               for an end `holds` keeps open (a paid order): a later `change` means it works again
 *   - heartbeat comment every 20 s keeps proxies from closing idle connections
 */
// `filter` is told which key the notification came on, so a stream can take only some events from a wide key (an outlet's).
export function serveStream(c: AppContext, keys: string[], hello: Record<string, unknown>, filter?: (n: Notification, key: string) => boolean, ended?: () => Promise<Record<string, unknown> | null>, holds?: (end: Record<string, unknown>) => boolean) {
  return streamSSE(c, async (stream) => {
    let id = 0;
    const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data), id: String(++id) });
    // With `ended`, each change is checked against the session first (in order of arrival): once it has ended, the
    // client hears `ended` instead of a change it could only answer with a request the register would refuse.
    let queue: Promise<void> = Promise.resolve();
    let over = false;
    let held = false;
    // A session that is held at connect (a paid phone reloaded on its paid screen, review 5 W1) hears `ended` first, not
    // `hello`, so it fetches nothing the register would refuse; a later change still tells it the session works again.
    // Subscribed before the check (below, the relay waits on `started`), so a void in between is relayed, not missed.
    let release: () => void = () => {};
    const started = new Promise<void>((r) => (release = r));
    queue = started;
    const unsubs = keys.map((k) =>
      subscribe(k, (n) => {
        if (filter && !filter(n, k)) return;
        queue = queue.then(() => relay(n)).catch(() => undefined);
      }),
    );
    const atStart = ended ? await ended().catch(() => null) : null;
    if (atStart && holds?.(atStart)) {
      held = true;
      await send("ended", atStart);
    } else if (atStart) {
      over = true;
      for (const u of unsubs) u();
      await send("ended", atStart);
      await stream.close();
      return;
    } else await send("hello", hello);
    const relay = async (n: Notification) => {
      if (over) return;
      if (n.kind === "print_job") return void (await send("job", { job_id: n.job_id, status: n.status, printer_id: n.printer_id }));
      // A resync makes the client refetch too, so it is checked like a change.
      const end = ended ? await ended().catch(() => null) : null;
      // An end the session may come back from (`holds`: the order was paid, and a void or reopen can put it back in
      // service) is said once and the stream stays open, relaying nothing until the session works again; the first
      // change after that tells the client it is back (review 4 U4).
      if (end && holds?.(end)) {
        if (!held) {
          held = true;
          await send("ended", end);
        }
        return;
      }
      held = false;
      if (end) {
        over = true;
        await send("ended", end);
        await stream.close();
        return;
      }
      if (n.kind === "resync") return void (await send("resync", {}));
      await send("change", { seq: n.seq, type: n.type, outlet_id: n.outlet_id, aggregate_kind: n.aggregate_kind, aggregate_id: n.aggregate_id });
    };
    release();
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
