import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { merchantSettings, outlets } from "../db/schema/index.js";
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

/** The current business date for a merchant and outlet. */
export async function businessToday(merchantId: string, outletId?: string | null, at = new Date()): Promise<{ bd: BusinessDayInputs; today: string }> {
  const bd = await businessDayInputs(merchantId, outletId);
  return { bd, today: businessDateFor(at, bd.cutoff, bd.timeZone) };
}
