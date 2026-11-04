import { AppError } from "./errors.js";

/**
 * Admission gate (Launchpad pattern): at most TX_MAX request transactions run
 * at once; QUEUE_MAX more wait; beyond that the request gets a 503 so the
 * database is never swamped.
 */
export class AdmissionGate {
  private running = 0;
  private readonly queue: (() => void)[] = [];
  rejected = 0;

  constructor(
    private readonly max: number,
    private readonly queueMax: number,
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
      return () => this.release();
    }
    if (this.queue.length >= this.queueMax) {
      this.rejected++;
      throw new AppError("overloaded", "The server is busy", { remedy: "Retry in a moment.", details: { in_flight: this.running, waiting: this.queue.length } });
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.running++;
    return () => this.release();
  }

  private release() {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}
