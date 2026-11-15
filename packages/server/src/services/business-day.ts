import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { businessDayCloses, merchantSettings, outlets } from "../db/schema/index.js";
import { businessDateFor } from "../lib/time.js";
import { AppError } from "../lib/errors.js";

/**
 * Business-day inputs for a merchant (and outlet): the cutoff time and the time
 * zone. Every "today" in the register (event stamping, daily caps, sold-out-for-
 * today, Z-reports, reopen) derives from these, never from the calendar date.
 */
export type BusinessDayInputs = { cutoff: string; timeZone: string };

export async function businessDayInputs(merchantId: string, outletId?: string | null): Promise<BusinessDayInputs> {
  const [s] = await db().select({ cutoff: merchantSettings.businessDayCutoff, timezone: merchantSettings.timezone }).from(merchantSettings).where(eq(merchantSettings.merchantId, merchantId)).limit(1);
  if (!s) throw AppError.notFound("merchant settings", merchantId);
  let cutoff = s.cutoff;
  if (outletId) {
    const [o] = await db().select({ cutoff: outlets.businessDayCutoff }).from(outlets).where(eq(outlets.id, outletId)).limit(1);
    if (o?.cutoff) cutoff = o.cutoff;
  }
  return { cutoff, timeZone: s.timezone };
}

/** Time zone and locale printed on the merchant's tickets. */
export async function printLocale(merchantId: string): Promise<{ time_zone: string; locale: string }> {
  const [s] = await db().select({ timezone: merchantSettings.timezone, locale: merchantSettings.locale }).from(merchantSettings).where(eq(merchantSettings.merchantId, merchantId)).limit(1);
  if (!s) throw AppError.notFound("merchant settings", merchantId);
  return { time_zone: s.timezone, locale: s.locale };
}

async function isClosed(outletId: string, businessDate: string): Promise<boolean> {
  const [closed] = await db().select({ id: businessDayCloses.id }).from(businessDayCloses).where(and(eq(businessDayCloses.outletId, outletId), eq(businessDayCloses.businessDate, businessDate))).limit(1);
  return closed != null;
}

/** A closed business day can no longer change (pricing-semantics §10): a correction is a refund on a later day. */
export async function assertBusinessDayOpen(outletId: string, businessDate: string) {
  if (await isClosed(outletId, businessDate)) throw AppError.invariant("business_day_closed", `Business day ${businessDate} is closed`, "Correct it with a refund instead.");
}

/** The calendar day after a YYYY-MM-DD date. */
export function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * The business day new orders, shifts, payments and refunds are dated on: the clock's, or, once the clock's day has
 * been closed early (before the cutoff), the next one, so a closed day's stored Z-report never changes (§10).
 */
export async function currentBusinessDate(merchantId: string, outletId: string, at = new Date()): Promise<string> {
  const { today } = await businessToday(merchantId, outletId, at);
  return (await isClosed(outletId, today)) ? nextDate(today) : today;
}

/** The current business date for a merchant and outlet. */
export async function businessToday(merchantId: string, outletId?: string | null, at = new Date()): Promise<{ bd: BusinessDayInputs; today: string }> {
  const bd = await businessDayInputs(merchantId, outletId);
  return { bd, today: businessDateFor(at, bd.cutoff, bd.timeZone) };
}
