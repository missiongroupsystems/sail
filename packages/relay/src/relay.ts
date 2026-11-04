import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { probe, sendJob, PrinterError, type PrinterTarget } from "./printer.js";

/**
 * The relay loop (scope doc 4.7): pair once, then hold an SSE stream to the
 * register, catch up on queued jobs after every (re)connect, claim → send →
 * acknowledge each job with retries and backoff, and send a heartbeat every
 * 30 seconds with printer reachability. Job IDs are reused on retry; a partial
 * send can print a duplicate, which is accepted.
 */
export type RelayConfig = {
  apiUrl: string;
  stateFile: string;
  pairingCode?: string;
  version: string;
  log: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
};

type State = { relay_id: string; token: string; outlet_id: string };
type Printer = { id: string; name: string; ip: string; port: number; supports_status: boolean };
type Job = { id: string; printer_id: string; payload?: string; status: string; attempts: number };

export class Relay {
  private state: State | null = null;
  private printers = new Map<string, Printer>();
  private stopped = false;
  private inFlight = new Set<string>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly fetch: typeof fetch;
  constructor(private readonly cfg: RelayConfig) {
    this.fetch = cfg.fetchImpl ?? fetch;
  }

  async start() {
    this.state = this.loadState() ?? (await this.pair());
    await this.loadPrinters();
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), 30_000);
    void this.heartbeat();
    void this.streamLoop();
  }

  async stop() {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
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
    if (!this.state) return;
    const status: Record<string, { ok: boolean; checked_at: string; error?: string }> = {};
    for (const p of this.printers.values()) status[p.id] = { ...(await probe(p)), checked_at: new Date().toISOString() };
    try {
      await this.api("POST", `/v1/relays/${this.state.relay_id}/heartbeat`, { version: this.cfg.version, printer_status: status });
    } catch (e) {
      this.cfg.log("warn", "heartbeat failed", { error: (e as Error).message });
    }
  }

  /** Fetch everything outstanding and process it. Called on connect, on every `job`/`resync` signal, and periodically as a safety net. */
  async catchUp() {
    const res = await this.api<{ data: Job[] }>("GET", `/v1/relays/${this.state!.relay_id}/jobs`);
    for (const job of res.data) void this.process(job);
  }

  async process(job: Job) {
    if (this.inFlight.has(job.id)) return;
    this.inFlight.add(job.id);
    try {
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
        try {
          await sendJob(printer as PrinterTarget, bytes);
          await this.ack(job.id, true);
          this.cfg.log("info", "printed", { job_id: job.id, printer: printer.name, attempt });
          return;
        } catch (e) {
          lastError = (e as Error).message;
          this.cfg.log("warn", "print attempt failed", { job_id: job.id, printer: printer.name, attempt, error: lastError });
          if (e instanceof PrinterError && e.permanent) break;
          await sleep(Math.min(8000, 500 * 2 ** attempt));
        }
      }
      await this.ack(job.id, false, lastError);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status !== 409) this.cfg.log("error", "job processing failed", { job_id: job.id, error: (e as Error).message });
    } finally {
      this.inFlight.delete(job.id);
    }
  }

  private async ack(jobId: string, ok: boolean, error?: string) {
    await this.api("POST", `/v1/relays/${this.state!.relay_id}/jobs/${jobId}/ack`, { ok, error });
  }

  private async streamLoop() {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        await this.catchUp();
        const res = await this.fetch(`${this.cfg.apiUrl}/v1/relays/${this.state!.relay_id}/stream`, { headers: this.headers() });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        backoff = 1000;
        this.cfg.log("info", "stream connected");
        await this.readStream(res.body);
        this.cfg.log("warn", "stream ended");
      } catch (e) {
        this.cfg.log("warn", "stream error", { error: (e as Error).message });
      }
      if (this.stopped) break;
      await sleep(backoff);
      backoff = Math.min(30_000, backoff * 2);
    }
  }

  private async readStream(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let safety = setTimeout(() => void this.catchUp(), 60_000);
    try {
      while (!this.stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (block.startsWith(":")) continue;
          const event = block.split("\n").find((l) => l.startsWith("event:"))?.slice(6).trim();
          if (event === "job" || event === "resync" || event === "hello") {
            clearTimeout(safety);
            safety = setTimeout(() => void this.catchUp(), 60_000);
            void this.catchUp();
          }
        }
      }
    } finally {
      clearTimeout(safety);
      reader.cancel().catch(() => {});
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
