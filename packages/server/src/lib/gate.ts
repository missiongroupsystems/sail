import { AppError } from "./errors.js";

/**
 * Admission gate (Launchpad pattern): at most TX_MAX request transactions run
 * at once; QUEUE_MAX more wait; beyond that the request gets a 503 so the
 * database is never swamped.
 */
export class AdmissionGate {
  private running = 0;
  private readonly queue: { resolve: () => void; reject: (e: Error) => void }[] = [];
  rejected = 0;
  timedOut = 0;

  constructor(
    private readonly max: number,
    private readonly queueMax: number,
    /** A queued request waits at most this long for a slot before it gets a 503 (defence against a stalled database or a slot leak). */
    private readonly waitMs = 10_000,
  ) {}

  get inFlight() {
    return this.running;
  }
  get waiting() {
    return this.queue.length;
  }

  async acquire(): Promise<() => void> {
    if (this.running < this.max) {
      this.running++;
      return this.releaser();
    }
    if (this.queue.length >= this.queueMax) {
      this.rejected++;
      throw new AppError("overloaded", "The server is busy", { remedy: "Retry in a moment.", details: { in_flight: this.running, waiting: this.queue.length } });
    }
    await new Promise<void>((resolve, reject) => {
      const entry = { resolve, reject };
      this.queue.push(entry);
      const timer = setTimeout(() => {
        const i = this.queue.indexOf(entry);
        if (i < 0) return; // already admitted
        this.queue.splice(i, 1);
        this.timedOut++;
        reject(new AppError("overloaded", "The server is busy", { remedy: "Retry in a moment.", details: { in_flight: this.running, waiting: this.queue.length, waited_ms: this.waitMs } }));
      }, this.waitMs);
      entry.resolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.running++;
    return this.releaser();
  }

  /** Idempotent release: a double call (handler and error path) must never free two slots. */
  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private release() {
    this.running--;
    const next = this.queue.shift();
    if (next) next.resolve();
  }
}
