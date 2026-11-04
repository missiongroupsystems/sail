import { eq } from "drizzle-orm";
import type { RequestTx } from "../db/client.js";
import { staff, staffSessions, stations } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import { config } from "../config.js";
import type { Principal } from "./principal.js";
import { peekTokenType, verifyBackOfficeToken, verifySailToken } from "./tokens.js";

/**
 * Turn a bearer token into a Principal. Runs inside the request transaction
 * BEFORE SET LOCAL ROLE, so it can look up the staff row across merchants by
 * the unique auth subject. Later phases add guest, relay and agent resolution.
 */
export async function resolvePrincipal(token: string, t: RequestTx): Promise<Principal> {
  const typ = peekTokenType(token);
  if (typ === null) throw new AppError("unauthenticated", "Malformed token");

  if (typ === "external") {
    const { sub } = await verifyBackOfficeToken(token);
    const [row] = await t.db.select().from(staff).where(eq(staff.authSubject, sub)).limit(1);
    if (!row || !row.active) throw new AppError("unauthenticated", "No active staff record for this sign-in", { remedy: "Ask an Admin to add you to the team." });
    return { type: "staff", id: row.id, merchantId: row.merchantId, role: row.role, name: row.name, outletIds: row.outletIds, brandIds: row.brandIds, riskCeiling: row.riskCeiling, via: "backoffice" };
  }

  if (typ === "station") {
    const claims = await verifySailToken(token, "station");
    const [st] = await t.db.select().from(stations).where(eq(stations.id, claims.station_id!)).limit(1);
    if (!st || st.archivedAt || !st.tokenHash) throw new AppError("unauthenticated", "This station is no longer paired", { remedy: "Pair the iPad again from the back office." });
    return { type: "station", id: st.id, merchantId: st.merchantId, outletId: st.outletId, stationId: st.id };
  }

  if (typ === "pin") {
    const claims = await verifySailToken(token, "pin");
    const [sess] = await t.db.select().from(staffSessions).where(eq(staffSessions.id, claims.session_id!)).limit(1);
    if (!sess || sess.endedAt) throw new AppError("unauthenticated", "Your PIN session has ended", { remedy: "Sign in again with your PIN." });
    const idle = (Date.now() - sess.lastSeenAt.getTime()) / 1000;
    if (idle > config().PIN_SESSION_IDLE_SECONDS) {
      await t.db.update(staffSessions).set({ endedAt: new Date() }).where(eq(staffSessions.id, sess.id));
      throw new AppError("unauthenticated", "Your PIN session expired after inactivity", { remedy: "Sign in again with your PIN." });
    }
    await t.db.update(staffSessions).set({ lastSeenAt: new Date() }).where(eq(staffSessions.id, sess.id));
    const [row] = await t.db.select().from(staff).where(eq(staff.id, sess.staffId)).limit(1);
    if (!row || !row.active) throw new AppError("unauthenticated", "Staff record is inactive");
    return {
      type: "staff",
      id: row.id,
      merchantId: row.merchantId,
      role: row.role,
      name: row.name,
      outletIds: row.outletIds,
      brandIds: row.brandIds,
      stationId: sess.stationId,
      sessionId: sess.id,
      outletId: sess.outletId,
      riskCeiling: row.riskCeiling,
      via: "pin",
    };
  }

  if (typ === "guest") return resolveGuest(token, t);
  if (typ === "relay") return resolveRelay(token, t);
  if (typ === "agent") return resolveAgent(token, t);
  throw new AppError("unauthenticated", "Unsupported token type");
}

// Extended by later phases (v0.5 relay, v0.8 guest, agents). Each module registers its resolver.
type Resolver = (token: string, t: RequestTx) => Promise<Principal>;
let guestResolver: Resolver = async () => {
  throw new AppError("unauthenticated", "Guest access is not enabled");
};
let relayResolver: Resolver = async () => {
  throw new AppError("unauthenticated", "Relay access is not enabled");
};
let agentResolver: Resolver = async () => {
  throw new AppError("unauthenticated", "Agent access is not enabled");
};
export function registerGuestResolver(r: Resolver) {
  guestResolver = r;
}
export function registerRelayResolver(r: Resolver) {
  relayResolver = r;
}
export function registerAgentResolver(r: Resolver) {
  agentResolver = r;
}
const resolveGuest: Resolver = (tok, t) => guestResolver(tok, t);
const resolveRelay: Resolver = (tok, t) => relayResolver(tok, t);
const resolveAgent: Resolver = (tok, t) => agentResolver(tok, t);
