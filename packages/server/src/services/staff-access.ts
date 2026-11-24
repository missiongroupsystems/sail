import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { backofficeLinks, backofficeSessions } from "../db/schema/index.js";

/** A deactivated person's back-office sessions end and their open sign-in links stop, so reactivating does not bring them back. */
export async function endBackofficeAccess(staffId: string) {
  await db().update(backofficeSessions).set({ endedAt: new Date() }).where(and(eq(backofficeSessions.staffId, staffId), isNull(backofficeSessions.endedAt)));
  await db().update(backofficeLinks).set({ revokedAt: new Date() }).where(and(eq(backofficeLinks.staffId, staffId), isNull(backofficeLinks.usedAt), isNull(backofficeLinks.revokedAt)));
}
