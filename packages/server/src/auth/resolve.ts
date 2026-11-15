import { eq } from "drizzle-orm";
import type { RequestTx } from "../db/client.js";
import { staff, staffSessions, stations } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import { config } from "../config.js";
import type { Principal } from "./principal.js";
import { identityProvider } from "./identity.js";
import { peekTokenType, sha256, verifySailToken } from "./tokens.js";

/**
 * Turn a bearer token into a Principal. Runs inside the request transaction
 * BEFORE SET LOCAL ROLE, so it can look up the staff row across merchants by
 * the unique auth subject. Later phases add guest, relay and agent resolution.
 * `activity` says whether the request is something a person did (any non-GET): only that keeps a PIN session from
 * idling out, so a POS that polls or streams in the background does not keep an unattended session alive.
 */
export async function resolvePrincipal(token: string, t: RequestTx, opts: { activity: boolean } = { activity: true }): Promise<Principal> {
  const typ = peekTokenType(token);
  if (typ === null) throw new AppError("unauthenticated", "Malformed token");

  // Back-office sign-in goes through the configured identity provider (auth/identity.ts).
  if (typ === "external" || typ === "session") return identityProvider().authenticate(token, typ, t);

  if (typ === "station") {
    const claims = await verifySailToken(token, "station");
    // FOR SHARE waits for a pairing in flight, so a PIN session cannot start on the old token while another device pairs
    // (resolve.ts would otherwise see the old hash, and the session would start after the new pairing's time).
    const [st] = await t.db.select().from(stations).where(eq(stations.id, claims.station_id!)).limit(1).for("share");
    // Pairing again replaces the stored hash, so an older token (lost or stolen iPad) stops working.
    if (!st || st.archivedAt || !st.tokenHash || st.tokenHash !== sha256(token)) throw new AppError("unauthenticated", "This station is no longer paired", { remedy: "Pair the iPad again from the back office." });
    return { type: "station", id: st.id, merchantId: st.merchantId, outletId: st.outletId, stationId: st.id };
  }

  if (typ === "pin") {
    const claims = await verifySailToken(token, "pin");
    const [found] = await t.db.select({ sess: staffSessions, station: { archivedAt: stations.archivedAt, tokenHash: stations.tokenHash, pairedAt: stations.pairedAt } }).from(staffSessions).innerJoin(stations, eq(stations.id, staffSessions.stationId)).where(eq(staffSessions.id, claims.session_id!)).limit(1);
    const sess = found?.sess;
    if (!sess || sess.endedAt) throw new AppError("unauthenticated", "Your PIN session has ended", { remedy: "Sign in again with your PIN." });
    // A session lives only as long as the station's pairing it started under: archiving or pairing another device ends it.
    const st = found.station;
    if (st.archivedAt || !st.tokenHash || (st.pairedAt && sess.startedAt < st.pairedAt)) {
      await t.db.update(staffSessions).set({ endedAt: new Date() }).where(eq(staffSessions.id, sess.id));
      throw new AppError("unauthenticated", "This station is no longer paired", { remedy: "Pair the iPad again from the back office." });
    }
    const idle = (Date.now() - sess.lastSeenAt.getTime()) / 1000;
    if (idle > config().PIN_SESSION_IDLE_SECONDS) {
      await t.db.update(staffSessions).set({ endedAt: new Date() }).where(eq(staffSessions.id, sess.id));
      throw new AppError("unauthenticated", "Your PIN session expired after inactivity", { remedy: "Sign in again with your PIN." });
    }
    // Best-effort: skip when another request of the same session holds the row (a proposal approval replays a frozen request inside the approver's request).
    if (opts.activity) await t.sql`update staff_sessions set last_seen_at = now() where id in (select id from staff_sessions where id = ${sess.id} for update skip locked)`;
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
