import { inject } from "vitest";

/**
 * Opt-in: SAIL_TEST_NOW=<ISO instant> runs the suite as if it started at that instant, so a run can check that no test
 * depends on the real time of day (SAIL_TEST_NOW=2026-01-01T16:00:30Z is 00:00:30 in Singapore). The test process's
 * Date and Postgres' now() and clock_timestamp() (test/global-setup.ts) move by the same fixed offset and keep ticking
 * in step, so rows Postgres stamps and times the register reads still agree.
 */
const offsetMs = inject("clockOffsetMs");
if (offsetMs) {
  const RealDate = Date;
  class OffsetDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + offsetMs);
      else super(...(args as [string | number | Date]));
    }
    static override now(): number {
      return RealDate.now() + offsetMs;
    }
  }
  globalThis.Date = OffsetDate as DateConstructor;
}
