import type { EventsPage, OutletEvent } from "../api/types";

export type StreamStatus = "online" | "reconnecting" | "offline";

export type OutletStreamOptions = {
  baseUrl: string;
  outletId: string;
  getToken: () => string | null;
  /** Catch-up fetch (events.list). The stream only signals; this is the source of truth. */
  fetchEvents: (after: number) => Promise<EventsPage>;
  onEvents: (events: OutletEvent[]) => void;
  onStatus: (status: StreamStatus, asOf: number | null) => void;
  /** Called on every `hello`, so the first connection can refresh the views it missed before connecting. */
  onConnected?: (firstTime: boolean) => void;
  /** A print job changed: the POS refreshes the late-job list. */
  onJob?: (job: { job_id: string; status: string; printer_id: string | null }) => void;
};

/** The streams of this page, so a register call that could not reach the API can say so at once. */
const live = new Set<OutletStream>();

/**
 * A register call failed without reaching the API. The stream's own silence takes three missed heartbeats (65 s) to
 * notice, so the station would say "online" meanwhile: drop the stream now, show the connection as lost, and let the
 * reconnect decide.
 */
export function reportUnreachable() {
  for (const s of live) s.unreachable();
}

/** Heartbeats arrive every 20 s; three missed means the connection is gone. */
const STALE_MS = 65_000;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];

/**
 * The outlet event store's transport: SSE over `fetch`
 * streaming with a Bearer token. On `hello` it compares sequence numbers, on
 * `change` or `resync` it catches up through `events?after=`, reconnects with
 * exponential backoff, and catches up again when the tab becomes visible.
 */
export class OutletStream {
  private abort: AbortController | null = null;
  private lastSeq: number | null = null;
  private attempts = 0;
  private stopped = false;
  private catchingUp = false;
  private catchUpAgain = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHeard: number | null = null;
  private connectedOnce = false;
  private status: StreamStatus = "reconnecting";

  constructor(private readonly opts: OutletStreamOptions) {}

  start() {
    this.stopped = false;
    live.add(this);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    void this.connect();
  }

  stop() {
    this.stopped = true;
    live.delete(this);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.abort?.abort();
    this.abort = null;
  }

  /** Pull everything after the last sequence we applied. Coalesces concurrent calls. */
  async catchUp(): Promise<void> {
    if (this.catchingUp) {
      this.catchUpAgain = true;
      return;
    }
    this.catchingUp = true;
    try {
      do {
        this.catchUpAgain = false;
        let more = true;
        while (more && !this.stopped) {
          const page = await this.opts.fetchEvents(this.lastSeq ?? 0);
          if (page.data.length) {
            this.opts.onEvents(page.data);
            this.lastSeq = Math.max(this.lastSeq ?? 0, page.data[page.data.length - 1]!.seq);
          }
          this.lastSeq = Math.max(this.lastSeq ?? 0, page.latest_seq);
          more = page.has_more;
        }
        this.heard();
      } while (this.catchUpAgain && !this.stopped);
    } catch {
      // The next change or reconnect tries again; the stream status already says we are behind.
    } finally {
      this.catchingUp = false;
    }
  }

  private onVisibility = () => {
    if (document.visibilityState !== "visible" || this.stopped) return;
    if (!this.abort) {
      this.attempts = 0;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      void this.connect();
    } else void this.catchUp();
  };

  private onOnline = () => {
    if (this.stopped || this.abort) return;
    this.attempts = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    void this.connect();
  };

  /** The device says the network is gone: say so now, rather than after the heartbeats go missing. */
  private onOffline = () => {
    if (this.stopped) return;
    this.setStatus("offline");
    this.abort?.abort();
  };

  unreachable() {
    if (this.stopped || this.status !== "online") return;
    this.setStatus(navigator.onLine === false ? "offline" : "reconnecting");
    this.abort?.abort();
  }

  private setStatus(status: StreamStatus) {
    if (status === this.status && status !== "online") return;
    this.status = status;
    this.opts.onStatus(status, this.lastHeard);
  }

  private heard() {
    this.lastHeard = Date.now();
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      // Silence past three heartbeats: drop the socket and reconnect.
      this.abort?.abort();
    }, STALE_MS);
    this.setStatus("online");
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const token = this.opts.getToken();
    if (!token) {
      this.scheduleReconnect();
      return;
    }
    const controller = new AbortController();
    this.abort = controller;
    try {
      const res = await fetch(`${this.opts.baseUrl}/v1/outlets/${this.opts.outletId}/stream`, {
        headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
        signal: controller.signal,
        cache: "no-store",
      });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      this.attempts = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        this.heard();
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          this.dispatch(chunk);
        }
      }
      throw new Error("stream ended");
    } catch {
      if (this.stopped) return;
      if (this.abort === controller) this.abort = null;
      this.scheduleReconnect();
    }
  }

  private dispatch(chunk: string) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith(":")) continue; // heartbeat comment
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    let data: { seq?: number; job_id?: string; status?: string; printer_id?: string | null } = {};
    try {
      data = JSON.parse(dataLines.join("\n")) as typeof data;
    } catch {
      return;
    }
    if (event === "hello") {
      const seq = typeof data.seq === "number" ? data.seq : 0;
      const first = !this.connectedOnce;
      this.connectedOnce = true;
      if (this.lastSeq === null) this.lastSeq = seq;
      else if (seq > this.lastSeq) void this.catchUp();
      this.opts.onConnected?.(first);
      this.setStatus("online");
    } else if (event === "change") {
      const seq = typeof data.seq === "number" ? data.seq : null;
      if (seq !== null && this.lastSeq !== null && seq <= this.lastSeq) return;
      void this.catchUp();
    } else if (event === "resync") {
      void this.catchUp();
    } else if (event === "job") {
      if (typeof data.job_id === "string") this.opts.onJob?.({ job_id: data.job_id, status: String(data.status ?? ""), printer_id: data.printer_id ?? null });
    }
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    if (this.staleTimer) clearTimeout(this.staleTimer);
    const delay = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)]!;
    this.attempts++;
    this.setStatus(this.attempts <= 2 && navigator.onLine !== false ? "reconnecting" : "offline");
    this.reconnectTimer = setTimeout(() => void this.connect(), delay + Math.random() * 300);
  }
}
