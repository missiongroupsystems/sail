export type GuestStreamStatus = "live" | "polling" | "reconnecting";

export type GuestStreamOptions = {
  baseUrl: string;
  getToken: () => string | null;
  /** Something about the table's order changed (or may have): refetch `/v1/guest/order`. */
  onChange: () => void;
  /** The outlet's stock changed (an item sold out or back): refetch the menu. */
  onStock?: () => void;
  onStatus?: (status: GuestStreamStatus) => void;
  /** The register rejected the token: the table session has ended (its reason in `details.reason`, when it gives one). */
  onUnauthenticated?: (details?: Record<string, unknown>) => void;
  /**
   * The order was paid and the stream stays open (review 4 U4): a later change means it is open again (a payment voided,
   * the order reopened) and the session works. Without it, `ended` stops the stream whatever the reason.
   */
  onResumed?: () => void;
  /** How often to refetch while there is no order to stream (15 s). */
  pollMs?: number;
};

/** Heartbeats arrive every 20 s; three missed means the connection is gone. */
const STALE_MS = 65_000;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const COALESCE_MS = 150;
/** How long a paid phone keeps listening for a void or a reopen (the register's window is 30 minutes). */
const HELD_MS = 30 * 60_000;

/**
 * Live updates for the guest: `/v1/guest/stream` over
 * `fetch` streaming with the Bearer token. The stream only signals; every
 * `hello`, `change` and `resync` makes the app refetch the order view, as does
 * the tab becoming visible again. `ended` means the table session has ended:
 * the stream stops and reports it as the register's refusal would. While the table has no order the register
 * answers 409, so the client polls instead and retries the stream each time.
 */
export class GuestStream {
  private abort: AbortController | null = null;
  private attempts = 0;
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private status: GuestStreamStatus | null = null;
  /** Paid: the register said `ended` and kept the stream open; nothing goes out with the token until a change. */
  private held = false;

  constructor(private readonly opts: GuestStreamOptions) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("online", this.onOnline);
    void this.connect();
  }

  stop() {
    this.stopped = true;
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("online", this.onOnline);
    this.clearTimers();
    this.abort?.abort();
    this.abort = null;
  }

  /** Connected and hearing the register (a paid phone that still listens needs no other check). */
  get listening(): boolean {
    return !this.stopped && this.abort !== null;
  }

  /** Try the stream again now (after the first round opened the order, say). */
  kick() {
    if (this.stopped) return;
    this.attempts = 0;
    if (this.timer) clearTimeout(this.timer);
    if (this.abort) return; // already connected or connecting
    void this.connect();
  }

  private clearTimers() {
    if (this.timer) clearTimeout(this.timer);
    if (this.staleTimer) clearTimeout(this.staleTimer);
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.timer = this.staleTimer = this.changeTimer = null;
  }

  private onVisibility = () => {
    if (document.visibilityState !== "visible" || this.stopped || this.held) return;
    this.change();
    if (!this.abort) this.kick();
  };

  private onOnline = () => {
    if (!this.stopped && !this.abort) this.kick();
  };

  private setStatus(s: GuestStreamStatus) {
    if (s === this.status) return;
    this.status = s;
    this.opts.onStatus?.(s);
  }

  /** Coalesce bursts of events into one refetch. */
  private change() {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.opts.onChange();
    }, COALESCE_MS);
  }

  private heard() {
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => this.abort?.abort(), STALE_MS);
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.connect(), ms);
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.abort) return;
    const token = this.opts.getToken();
    if (!token) {
      this.setStatus("reconnecting");
      this.schedule(2000);
      return;
    }
    const controller = new AbortController();
    this.abort = controller;
    try {
      const res = await fetch(`${this.opts.baseUrl}/v1/guest/stream`, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: controller.signal, cache: "no-store" });
      if (res.status === 401) {
        this.abort = null;
        const body = (await res.json().catch(() => null)) as { details?: Record<string, unknown> } | null;
        this.opts.onUnauthenticated?.(body?.details);
        this.stop();
        return;
      }
      if (res.status === 409) {
        // No order yet for this table: poll the order view and try the stream again each time.
        this.abort = null;
        this.setStatus("polling");
        this.schedule(this.opts.pollMs ?? 15_000);
        this.change();
        return;
      }
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
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          this.frame(frame);
        }
      }
      throw new Error("stream ended");
    } catch {
      if (this.stopped || controller !== this.abort) return;
      // Paid and the connection dropped: reconnecting would only be refused (the session is ended). Stop quietly.
      if (this.held) return this.stop();
      this.abort = null;
      if (this.staleTimer) clearTimeout(this.staleTimer);
      this.setStatus("reconnecting");
      const delay = BACKOFF_MS[Math.min(this.attempts++, BACKOFF_MS.length - 1)]!;
      this.schedule(delay);
    }
  }

  private frame(frame: string) {
    let event = "message";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data = line.slice(5).trim();
      // Comment lines (": ping") are heartbeats. Only `ended` and a change's type are read; the order view is the source of truth.
    }
    if (this.held && (event === "change" || event === "resync") && !changeType(data).startsWith("stock.")) {
      // Paid, and now the order is open again: the session works.
      this.held = false;
      this.opts.onResumed?.();
      this.change();
      return;
    }
    if (this.held) return;
    if (event === "hello") {
      this.setStatus("live");
      this.change();
    } else if (event === "change" && changeType(data).startsWith("stock.")) {
      // The outlet's stock, not the table's order: the menu catches up, the order view has nothing new.
      this.opts.onStock?.();
    } else if (event === "change" || event === "resync") {
      this.change();
    } else if (event === "ended" && this.opts.onResumed && endReason(data) === "order_paid") {
      // Paid: say so, and keep listening without sending anything (no refetch, no reconnect) until a change.
      this.held = true;
      if (this.changeTimer) clearTimeout(this.changeTimer);
      this.changeTimer = null;
      // The register brings a paid table's phones back only within half an hour: past that, stop listening.
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.stop(), HELD_MS);
      this.opts.onUnauthenticated?.({ reason: "order_paid" });
    } else if (event === "ended") {
      // The table session has ended (the order was paid, say): nothing more goes out with its token, not even the
      // refetch an earlier change had queued, which the register would refuse with a 401.
      // Its data carries the reason the register's 401 would ("code_rotated" when the table has a new code).
      this.stop();
      let details: Record<string, unknown> | undefined;
      try {
        details = (JSON.parse(data) as Record<string, unknown> | null) ?? undefined;
      } catch {
        details = undefined;
      }
      this.opts.onUnauthenticated?.(details);
    }
  }
}

/** The reason an `ended` frame gives ("order_paid"), or null. */
function endReason(data: string): string | null {
  try {
    const r = (JSON.parse(data) as { reason?: unknown } | null)?.reason;
    return typeof r === "string" ? r : null;
  } catch {
    return null;
  }
}

/** The event type a `change` frame names ("stock.sold_out"), or "" when it names none. */
export function changeType(data: string): string {
  try {
    const t = (JSON.parse(data) as { type?: unknown } | null)?.type;
    return typeof t === "string" ? t : "";
  } catch {
    return "";
  }
}
