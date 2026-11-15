import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { probe, sendJob, PrinterError, type PrinterTarget } from "./printer.js";

/**
 * The relay loop: pair once, then hold an SSE stream to the
 * register, catch up on queued jobs after every (re)connect, claim → send →
 * acknowledge each job with retries and backoff, and send a heartbeat every
 * 30 seconds with printer reachability. Job IDs are reused on retry; a partial
 * send can print a duplicate, which is accepted. Jobs for one printer are sent
 * one at a time, in the order the register queued them. The relay holds no
 * business logic and never parses what it prints.
 */
export type RelayConfig = {
  apiUrl: string;
  stateFile: string;
  pairingCode?: string;
  version: string;
  log: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  /** Test hook: milliseconds between attempts (default exponential from 1 s, capped at 8 s). */
  retryDelayMs?: (attempt: number) => number;
};

type State = { relay_id: string; token: string; outlet_id: string };
type Printer = { id: string; name: string; ip: string; port: number; supports_status: boolean };
type Job = { id: string; printer_id: string; payload?: string; status: string; attempts: number };

/** Heartbeat comments arrive every 20 s; three missed means the connection is gone. */
const STREAM_STALE_MS = 65_000;
const SAFETY_NET_MS = 60_000;
const HEARTBEAT_MS = 30_000;
const STOP_GRACE_MS = 10_000;

export class Relay {
  private state: State | null = null;
  private printers = new Map<string, Printer>();
  private stopped = false;
  private inFlight = new Set<string>();
  /** One chain of work per printer, so tickets print in order over one connection at a time. */
  private queues = new Map<string, Promise<void>>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatBusy = false;
  private catchUpBusy = false;
  private catchUpAgain = false;
  private streamAbort: AbortController | null = null;
  private streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private readonly fetch: typeof fetch;
  constructor(private readonly cfg: RelayConfig) {
    this.fetch = cfg.fetchImpl ?? fetch;
  }

  async start() {
    this.state = this.loadState() ?? (await this.pair());
    // The register may be unreachable at boot (network still coming up); keep trying rather than crash-looping.
    for (let delay = 1000; ; delay = Math.min(30_000, delay * 2)) {
      try {
        await this.loadPrinters();
        break;
      } catch (e) {
        if (this.stopped) return;
        if ((e as { status?: number }).status === 401) {
          // The stored token was replaced (a spare was paired, runbook "Replace a relay"). A fresh code re-pairs this device.
          if (this.cfg.pairingCode) {
            this.cfg.log("warn", "stored relay token rejected; pairing with the new code");
            this.state = await this.pair();
            continue;
          }
          this.cfg.log("error", "this relay is no longer paired; start it with a new SAIL_RELAY_PAIRING_CODE", { retry_in_ms: 30_000 });
          await sleep(30_000);
          continue;
        }
        this.cfg.log("warn", "printers not loaded; retrying", { error: (e as Error).message, retry_in_ms: delay });
        await sleep(delay);
      }
    }
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
    void this.heartbeat();
    void this.streamLoop();
  }

  /** Graceful shutdown: stop taking work, release what has not been sent, give in-flight sends a moment to finish. */
  async stop() {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.streamAbort?.abort();
    this.streamReader?.cancel().catch(() => {});
    const pending = [...this.queues.values()];
    if (pending.length) await Promise.race([Promise.allSettled(pending), sleep(STOP_GRACE_MS)]);
  }

  private loadState(): State | null {
    try {
      return existsSync(this.cfg.stateFile) ? (JSON.parse(readFileSync(this.cfg.stateFile, "utf8")) as State) : null;
    } catch {
      return null;
    }
  }

  private async pair(): Promise<State> {
    if (!this.cfg.pairingCode) throw new Error("Not paired and SAIL_RELAY_PAIRING_CODE is not set");
    const res = await this.fetch(`${this.cfg.apiUrl}/v1/relays/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: this.cfg.pairingCode, version: this.cfg.version }) });
    if (!res.ok) throw new Error(`Pairing failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { data: { relay_token: string; relay: { id: string; outlet_id: string } } };
    const state: State = { relay_id: body.data.relay.id, token: body.data.relay_token, outlet_id: body.data.relay.outlet_id };
    mkdirSync(dirname(this.cfg.stateFile), { recursive: true });
    writeFileSync(this.cfg.stateFile, JSON.stringify(state), { mode: 0o600 });
    this.cfg.log("info", "paired", { relay_id: state.relay_id });
    return state;
  }

  private headers(extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${this.state!.token}`, "content-type": "application/json", ...extra };
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetch(`${this.cfg.apiUrl}${path}`, { method, headers: this.headers(method === "GET" ? {} : { "idempotency-key": crypto.randomUUID() }), body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`${method} ${path} → ${res.status}: ${text}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as T;
  }

  async loadPrinters() {
    const res = await this.api<{ data: Printer[] }>("GET", `/v1/relays/${this.state!.relay_id}/printers`);
    this.printers = new Map(res.data.map((p) => [p.id, p]));
    this.cfg.log("info", "printers loaded", { count: this.printers.size });
  }

  async heartbeat() {
    if (!this.state || this.stopped || this.heartbeatBusy) return;
    this.heartbeatBusy = true;
    try {
      const printers = [...this.printers.values()];
      const results = await Promise.all(printers.map((p) => probe(p)));
      const status: Record<string, { ok: boolean; checked_at: string; error?: string }> = {};
      const checkedAt = new Date().toISOString();
      printers.forEach((p, i) => (status[p.id] = { ...results[i]!, checked_at: checkedAt }));
      await this.api("POST", `/v1/relays/${this.state.relay_id}/heartbeat`, { version: this.cfg.version, printer_status: status });
    } catch (e) {
      this.cfg.log("warn", "heartbeat failed", { error: (e as Error).message });
    } finally {
      this.heartbeatBusy = false;
    }
  }

  /**
   * Fetch everything outstanding and queue it. Called on connect, on every
   * `job`/`resync` signal, and periodically as a safety net. One fetch at a
   * time: a signal that arrives mid-fetch schedules exactly one more.
   */
  async catchUp() {
    if (this.stopped) return;
    if (this.catchUpBusy) {
      this.catchUpAgain = true;
      return;
    }
    this.catchUpBusy = true;
    try {
      do {
        this.catchUpAgain = false;
        const res = await this.api<{ data: Job[] }>("GET", `/v1/relays/${this.state!.relay_id}/jobs`);
        for (const job of res.data) this.enqueue(job);
      } while (this.catchUpAgain && !this.stopped);
    } catch (e) {
      this.cfg.log("warn", "catch-up failed", { error: (e as Error).message });
    } finally {
      this.catchUpBusy = false;
    }
  }

  /** Put a job on its printer's chain unless it is already there. */
  private enqueue(job: Job) {
    if (this.stopped || this.inFlight.has(job.id)) return;
    this.inFlight.add(job.id);
    const prev = this.queues.get(job.printer_id) ?? Promise.resolve();
    const next: Promise<void> = prev
      .then(() => this.process(job))
      .catch(() => {})
      .finally(() => {
        this.inFlight.delete(job.id);
        if (this.queues.get(job.printer_id) === next) this.queues.delete(job.printer_id);
      });
    this.queues.set(job.printer_id, next);
  }

  /** Claim → (status) → send → ack, with retries that reuse the job id. */
  async process(job: Job) {
    try {
      if (this.stopped) {
        // Not started: a queued job stays queued for the next relay; one we already hold goes straight back.
        if (job.status === "claimed") await this.ack(job.id, false, "Relay stopping before the job was sent", true);
        return;
      }
      const claimed = job.status === "claimed" ? job : (await this.api<{ data: Job }>("POST", `/v1/relays/${this.state!.relay_id}/jobs/${job.id}/claim`, {})).data;
      const printer = this.printers.get(claimed.printer_id) ?? (await this.loadPrinters(), this.printers.get(claimed.printer_id));
      if (!printer) {
        await this.ack(job.id, false, "Printer is not configured for this relay's outlet");
        return;
      }
      const bytes = Buffer.from(claimed.payload ?? "", "base64");
      const maxAttempts = this.cfg.maxAttempts ?? 3;
      let lastError = "";
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (this.stopped) {
          // Shutting down with the job claimed but not sent: hand it straight back instead of waiting for the stale-claim worker.
          await this.ack(job.id, false, "Relay stopping before the job was sent", true);
          return;
        }
        try {
          await sendJob(printer as PrinterTarget, bytes);
          await this.ack(job.id, true);
          this.cfg.log("info", "printed", { job_id: job.id, printer: printer.name, attempt });
          return;
        } catch (e) {
          lastError = (e as Error).message;
          this.cfg.log("warn", "print attempt failed", { job_id: job.id, printer: printer.name, attempt, error: lastError });
          if (e instanceof PrinterError && e.permanent) break;
          if (attempt < maxAttempts) await sleep(this.cfg.retryDelayMs?.(attempt) ?? Math.min(8000, 500 * 2 ** attempt));
        }
      }
      await this.ack(job.id, false, lastError);
    } catch (e) {
      const status = (e as { status?: number }).status;
      // 409: another relay has the job, or it was rerouted meanwhile. Anything else leaves the claim to the stale-claim worker.
      if (status !== 409) this.cfg.log("error", "job processing failed", { job_id: job.id, error: (e as Error).message });
    }
  }

  /**
   * Report the result: `ok` → printed; `requeue` → back to queued for any relay;
   * otherwise failed with the printer's error (staff reprint or reroute). A
   * brief network blip must not turn a printed ticket into a stale claim and a
   * duplicate, so the ack itself is retried a few times.
   */
  private async ack(jobId: string, ok: boolean, error?: string, requeue = false) {
    const body = { ok, ...(error ? { error: error.slice(0, 300) } : {}), ...(requeue ? { requeue: true } : {}) };
    for (let attempt = 1; ; attempt++) {
      try {
        await this.api("POST", `/v1/relays/${this.state!.relay_id}/jobs/${jobId}/ack`, body);
        return;
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (attempt >= 3 || (status != null && status < 500)) throw e;
        await sleep(1000 * attempt);
      }
    }
  }

  private async streamLoop() {
    let backoff = 1000;
    while (!this.stopped) {
      const controller = new AbortController();
      this.streamAbort = controller;
      try {
        await this.catchUp();
        const res = await this.fetch(`${this.cfg.apiUrl}/v1/relays/${this.state!.relay_id}/stream`, { headers: this.headers(), signal: controller.signal });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        backoff = 1000;
        this.cfg.log("info", "stream connected");
        await this.readStream(res.body, controller);
        if (!this.stopped) this.cfg.log("warn", "stream ended");
      } catch (e) {
        if (!this.stopped) this.cfg.log("warn", "stream error", { error: (e as Error).message });
      } finally {
        if (this.streamAbort === controller) this.streamAbort = null;
      }
      if (this.stopped) break;
      await sleep(backoff);
      backoff = Math.min(30_000, backoff * 2);
    }
  }

  private async readStream(body: ReadableStream<Uint8Array>, controller: AbortController) {
    const reader = body.getReader();
    this.streamReader = reader;
    const decoder = new TextDecoder();
    let buffer = "";
    const resetSafety = () => setTimeout(() => void this.catchUp(), SAFETY_NET_MS);
    // A connection that goes silent (no heartbeat comment for 65 s) is dropped so the loop reconnects and catches up.
    const resetStale = () => setTimeout(() => {
      this.cfg.log("warn", "stream silent; reconnecting");
      controller.abort();
      reader.cancel().catch(() => {});
    }, STREAM_STALE_MS);
    let safety = resetSafety();
    let stale = resetStale();
    try {
      while (!this.stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        clearTimeout(stale);
        stale = resetStale();
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (block.startsWith(":")) continue;
          if (wantsCatchUp(block)) {
            clearTimeout(safety);
            safety = resetSafety();
            void this.catchUp();
          }
        }
      }
    } finally {
      clearTimeout(safety);
      clearTimeout(stale);
      if (this.streamReader === reader) this.streamReader = null;
      reader.cancel().catch(() => {});
    }
  }
}

/**
 * Which frames mean "fetch the queue": `hello` and `resync` always; a `job`
 * frame when the job is (back) in the queue. The register also signals our own
 * claims and acks, which need no round trip; anything unparseable is treated
 * as a signal, so a changed frame shape can only cost an extra fetch.
 */
export function wantsCatchUp(block: string): boolean {
  let event: string | undefined;
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (event === "hello" || event === "resync") return true;
  if (event !== "job") return false;
  try {
    const parsed = JSON.parse(data) as { status?: unknown };
    return typeof parsed.status !== "string" || parsed.status === "queued";
  } catch {
    return true;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
