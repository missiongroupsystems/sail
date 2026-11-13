import { and, eq, isNull } from "drizzle-orm";
import type { TransactionSql } from "postgres";
import { config, identityProviderKind } from "../config.js";
import type { RequestTx } from "../db/client.js";
import { auditLog, backofficeLogins, backofficeSessions, staff } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import type { Principal } from "./principal.js";
import { hashSecret, signSailToken, verifyBackOfficeToken, verifySailToken } from "./tokens.js";

/**
 * The back-office identity seam. Exactly one provider is active, chosen by configuration: `oidc` when an external
 * issuer is configured, `local` (email and password, sessions issued here) otherwise. A provider turns a back-office
 * bearer token into a staff principal; it never sees station, PIN, guest, relay or agent tokens.
 */
export type IdentityProvider = {
  kind: "local" | "oidc";
  authenticate(token: string, tokenType: "session" | "external", t: RequestTx): Promise<Principal>;
};

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;
/** A local session lasts twelve hours from sign-in, the lifetime of the web app's session cookie. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
/** The subject a local login gives `staff.auth_subject`, so `has_login` and revocation work the same for both providers. */
export const localSubject = (staffId: string) => `local:${staffId}`;

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Length only: at least 12 characters, no composition rules. */
export function checkPassword(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) throw AppError.validation(`A password needs at least ${PASSWORD_MIN_LENGTH} characters`, { remedy: "Use a longer password; a few unrelated words work well." });
  if (password.length > PASSWORD_MAX_LENGTH) throw AppError.validation(`A password can have at most ${PASSWORD_MAX_LENGTH} characters`);
  if (guessable(password)) throw AppError.validation("That password is too easy to guess", { remedy: "Avoid repeated characters, repeated blocks and runs such as 1234 or qwerty; a few unrelated words work well." });
}

/** Long but trivial: few distinct characters, one block repeated, or a straight run along the alphabet, digits or keyboard. */
function guessable(password: string): boolean {
  const p = password.toLowerCase();
  if (new Set(p).size < 5) return true;
  for (let n = 1; n <= p.length / 2; n++) if (p.length % n === 0 && p.slice(0, n).repeat(p.length / n) === p) return true;
  return ["abcdefghijklmnopqrstuvwxyz", "0123456789", "qwertyuiopasdfghjklzxcvbnm"].some((run) => {
    const twice = run + run;
    return twice.includes(p) || [...twice].reverse().join("").includes(p);
  });
}

function staffPrincipal(row: typeof staff.$inferSelect, sessionId?: string): Principal {
  return { type: "staff", id: row.id, merchantId: row.merchantId, role: row.role, name: row.name, outletIds: row.outletIds, brandIds: row.brandIds, riskCeiling: row.riskCeiling, via: "backoffice", backofficeSessionId: sessionId };
}

const signedOut = () => new AppError("unauthenticated", "Your back-office session has ended", { remedy: "Sign in again." });

const localProvider: IdentityProvider = {
  kind: "local",
  async authenticate(token, tokenType, t) {
    if (tokenType !== "session") throw new AppError("unauthenticated", "This server signs in with email and password", { remedy: "Sign in again." });
    const claims = await verifySailToken(token, "session");
    const [sess] = await t.db.select().from(backofficeSessions).where(eq(backofficeSessions.id, claims.session_id!)).limit(1);
    if (!sess || sess.endedAt || sess.expiresAt.getTime() <= Date.now() || sess.staffId !== claims.staff_id || sess.merchantId !== claims.merchant_id) throw signedOut();
    const [row] = await t.db.select().from(staff).where(eq(staff.id, sess.staffId)).limit(1);
    // Revoking access clears the subject; deactivating the staff member clears `active`. Either ends the session.
    if (!row || !row.active || row.authSubject !== localSubject(row.id)) throw signedOut();
    return staffPrincipal(row, sess.id);
  },
};

const oidcProvider: IdentityProvider = {
  kind: "oidc",
  async authenticate(token, tokenType, t) {
    if (tokenType !== "external") throw new AppError("unauthenticated", "This server signs in through its identity provider", { remedy: "Sign in again." });
    const { sub, email, emailVerified } = await verifyBackOfficeToken(token);
    const [row] = await t.db.select().from(staff).where(eq(staff.authSubject, sub)).limit(1);
    if (row) {
      if (!row.active) throw new AppError("unauthenticated", "No active staff record for this sign-in", { remedy: "Ask an Admin to add you to the team." });
      return staffPrincipal(row);
    }
    // First sign-in: link the subject to the staff member an Admin pre-authorised by this email. Unknown emails are refused, never provisioned.
    // Only an email the issuer itself says is verified: an absent claim proves nothing, and an issuer that lets anyone
    // sign up with any address would otherwise hand them an invited person's account.
    const linked = email && emailVerified === true ? await linkPreAuthorised(t, sub, normaliseEmail(email)) : null;
    if (!linked) throw new AppError("unauthenticated", "No active staff record for this sign-in", { remedy: "Ask an Admin to add you to the team." });
    return staffPrincipal(linked);
  },
};

async function linkPreAuthorised(t: RequestTx, sub: string, email: string) {
  const [login] = await t.db.select({ staffId: backofficeLogins.staffId }).from(backofficeLogins).where(eq(backofficeLogins.email, email)).limit(1);
  if (!login) return null;
  const [row] = await t.db
    .update(staff)
    .set({ authSubject: sub, updatedAt: new Date() })
    .where(and(eq(staff.id, login.staffId), isNull(staff.authSubject), eq(staff.active, true)))
    .returning();
  // Another request of the same first sign-in linked it a moment ago.
  if (!row) return (await t.db.select().from(staff).where(and(eq(staff.authSubject, sub), eq(staff.active, true))).limit(1))[0] ?? null;
  await t.db.insert(auditLog).values({ merchantId: row.merchantId, actorType: "staff", actorId: row.id, actorName: row.name, actorRole: row.role, action: "staff.login_linked", targetKind: "staff", targetId: row.id });
  return row;
}

export function identityProvider(): IdentityProvider {
  return identityProviderKind() === "oidc" ? oidcProvider : localProvider;
}

/* ---- Local provider: logins and sessions, written as the connection owner ---- */

/** Give a staff member a local login with this password, replacing any earlier one. Runs as the connection owner. */
export async function setLocalLogin(sql: TransactionSql, member: { id: string; merchantId: string }, email: string, password: string): Promise<void> {
  checkPassword(password);
  const hash = hashSecret(password);
  await sql`insert into backoffice_logins (staff_id, merchant_id, email, password_hash, password_changed_at) values (${member.id}, ${member.merchantId}, ${normaliseEmail(email)}, ${hash}, now())
    on conflict (staff_id) do update set email = excluded.email, password_hash = excluded.password_hash, password_changed_at = now()`;
  await sql`update staff set auth_subject = ${localSubject(member.id)}, updated_at = now() where id = ${member.id} and merchant_id = ${member.merchantId}`;
}

/** Pre-authorise an email for the `oidc` provider: the staff member is linked on their first sign-in with it. */
export async function preAuthoriseLogin(sql: TransactionSql, member: { id: string; merchantId: string }, email: string): Promise<void> {
  await sql`insert into backoffice_logins (staff_id, merchant_id, email) values (${member.id}, ${member.merchantId}, ${normaliseEmail(email)})`;
}

/** End every open local session of a staff member, except `keep`. */
export async function endSessions(sql: TransactionSql, staffId: string, keep: string | null = null): Promise<void> {
  await sql`update backoffice_sessions set ended_at = now() where staff_id = ${staffId} and ended_at is null ${keep ? sql`and id <> ${keep}` : sql``}`;
}

export type IssuedSession = { token: string; expires_at: string };

export async function issueSession(sql: TransactionSql, member: { id: string; merchantId: string }): Promise<IssuedSession> {
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  const [row] = await sql<{ id: string }[]>`insert into backoffice_sessions (merchant_id, staff_id, expires_at) values (${member.merchantId}, ${member.id}, ${expiresAt.toISOString()}) returning id`;
  const token = await signSailToken({ typ: "session", merchant_id: member.merchantId, staff_id: member.id, session_id: row!.id }, SESSION_TTL_SECONDS);
  return { token, expires_at: expiresAt.toISOString() };
}

/** Fails loudly at start-up rather than at the first sign-in. */
export function assertIdentityConfigured(): void {
  if (identityProviderKind() === "local" && !config().SESSION_TOKEN_SECRET) throw new Error("SESSION_TOKEN_SECRET is required for email and password sign-in (no external identity provider is configured)");
}
