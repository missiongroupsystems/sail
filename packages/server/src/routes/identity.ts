import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq, gt, isNull } from "drizzle-orm";
import { RegionPresetKeySchema, REGION_PRESETS, registerOperations, RoleSchema, type OperationSpec } from "@sail/shared";
import { config, identityProviderKind } from "../config.js";
import { db, sessionConnection, tx, withOwnTransaction, withTransaction } from "../db/client.js";
import { backofficeLinks, backofficeLogins, backofficeSessions, staff } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import type { AppContext, AppEnv } from "../lib/context.js";
import { dataResponse, defineOp, errorResponses, jsonBody, jsonResponse, mutationResponse, z, secret } from "../lib/openapi.js";
import { recordAudit } from "../lib/audit.js";
import { createMerchant, presetSettings } from "../bootstrap.js";
import { checkPassword, endSessions, issueSession, localSubject, normaliseEmail, PASSWORD_MAX_LENGTH, preAuthoriseLogin, setLocalLogin } from "../auth/identity.js";
import { hashSecret, randomToken, sha256, verifySecret } from "../auth/tokens.js";
import { clearPinFailures, takePinAttempt, type AttemptLimits } from "../services/pin-attempts.js";

/**
 * Back-office identity: first-run setup, email and password sign-in, sessions, invitations, reset links and access
 * revocation. None of it is reachable by agents: no operation lists the agent principal, none is exposed over MCP, and
 * none can become a proposal (a proposal stores the request and its result, and these carry passwords and links).
 */
const op = (s: Pick<OperationSpec, "op" | "summary" | "description" | "tier" | "minRole" | "principals">): OperationSpec => ({ ...s, overrideAllowed: false, reasonRequired: false, dryRun: false, emits: [], mcp: { expose: false, toolsets: [] } });

registerOperations({
  "auth.status": op({ op: "auth.status", summary: "How this server signs people in", description: "No authentication. Which identity provider the back office uses (`local`: email and password; `oidc`: an external issuer) and whether first-run setup is still needed (no merchant exists yet).", tier: "T0", minRole: null, principals: [] }),
  "auth.sign_in": op({ op: "auth.sign_in", summary: "Sign in to the back office with email and password", description: "No authentication; `local` provider only. Returns a 12-hour back-office session token. Unknown emails and wrong passwords get the same answer. Repeated failures lock the email for 15 minutes after 5 attempts, and the client address after 20.", tier: "T0", minRole: null, principals: [] }),
  "auth.sign_out": op({ op: "auth.sign_out", summary: "Sign out of the back office", description: "Ends the caller's back-office session. Station PIN sessions use staff_sessions.end.", tier: "T0", minRole: null, principals: ["staff"] }),
  "auth.change_password": op({ op: "auth.change_password", summary: "Change your back-office password", description: "`local` provider only. Needs the current password; wrong ones count towards the email's sign-in lockout. Ends the caller's other sessions.", tier: "T1", minRole: null, principals: ["staff"] }),
  "auth.accept_link": op({ op: "auth.accept_link", summary: "Set a password from an invitation or reset link", description: "No authentication; the link's token is single-use and expires (invitations after 7 days, resets after 24 hours). Sets the password, ends every earlier session of that person and signs them in.", tier: "T3", minRole: null, principals: [] }),
  "setup.create": op({ op: "setup.create", summary: "First-run setup", description: "No authentication, and only while the server has no merchant: creates the merchant from a region preset, its first brand, outlet and station, and the first Admin with a back-office login, then signs the Admin in. Refused once any merchant exists, including when two setups race.", tier: "T3", minRole: null, principals: [] }),
  "staff.access": op({ op: "staff.access", summary: "A staff member's back-office access", description: "Admin. Whether the person can sign in to the back office, has an invitation pending, or neither, and the open link's expiry. Never returns a link.", tier: "T0", minRole: "admin", principals: ["staff"] }),
  "staff.invite": op({ op: "staff.invite", summary: "Invite a staff member to the back office", description: "Admin. `local`: returns a single-use link, valid 7 days and shown once, where the person sets a password; any earlier open link stops working. `oidc`: pre-authorises the staff member's email, linked to the identity provider's account on their first sign-in. The staff member needs an email; POS PINs are unaffected.", tier: "T3", minRole: "admin", principals: ["staff"] }),
  "staff.reset_password": op({ op: "staff.reset_password", summary: "Generate a password reset link", description: "Admin; `local` provider only. Returns a single-use link, valid 24 hours and shown once. Using it sets a new password and ends the person's sessions; any earlier open link stops working.", tier: "T3", minRole: "admin", principals: ["staff"] }),
  "staff.revoke_access": op({ op: "staff.revoke_access", summary: "Revoke a staff member's back-office access", description: "Admin. Removes the login, ends every back-office session and cancels open links. The staff record and POS PIN stay. You cannot revoke your own access.", tier: "T3", minRole: "admin", principals: ["staff"] }),
});

/** Pre-tenant counters (sign-in happens before anyone knows the merchant) live under the nil merchant, which no RLS context ever matches. */
const NO_MERCHANT = "00000000-0000-0000-0000-000000000000";
const EMAIL_LIMITS: AttemptLimits = { maxFailures: 5, lockSeconds: 15 * 60, what: "sign-in attempts for this email" };
const ADDRESS_LIMITS: AttemptLimits = { maxFailures: 20, lockSeconds: 15 * 60, what: "sign-in attempts from this address" };
const emailScope = (email: string) => `signin-email:${sha256(email)}`;
const INVITE_DAYS = 7;
const RESET_HOURS = 24;

let dummyHash: string | null = null;
/** Compared against when there is no stored hash, so an unknown email costs the same scrypt work as a wrong password. */
const noHash = () => (dummyHash ??= hashSecret(randomToken()));

const notRecognised = () => new AppError("unauthenticated", "Email or password not recognised", { remedy: "Check both and try again. After 5 failed attempts the email is locked for 15 minutes." });
const alreadySetUp = () => new AppError("state_conflict", "This server is already set up", { remedy: "Sign in instead; an Admin can invite more people from Team." });
const linkUnusable = () => new AppError("unauthenticated", "This link has expired or has already been used", { remedy: "Ask an Admin for a new link." });

function requireLocal(what: string) {
  if (identityProviderKind() !== "local") throw new AppError("not_found", `${what} is not used on this server`, { remedy: "Sign in through your organisation's identity provider." });
}

/** The caller's address for the per-address lockout: the socket peer, or the last X-Forwarded-For entry behind a trusted proxy. */
function clientAddress(c: AppContext): string {
  if (config().TRUST_PROXY) {
    const last = c.req.header("x-forwarded-for")?.split(",").pop()?.trim();
    if (last) return last;
  }
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? "unknown";
}

const Password = secret(z.string().max(PASSWORD_MAX_LENGTH));
const SessionOut = z.object({ token: secret(z.string()), expires_at: z.string(), staff: z.object({ id: z.string(), name: z.string(), role: RoleSchema }) });
const AccessOut = z.object({
  provider: z.enum(["local", "oidc"]),
  status: z.enum(["none", "invited", "active"]),
  email: z.string().nullable(),
  link: z.object({ kind: z.enum(["invite", "reset"]), expires_at: z.string() }).nullable(),
});
const LinkOut = z.object({ kind: z.enum(["link", "pre_authorised"]), email: z.string(), url: secret(z.string()).nullable(), expires_at: z.string().nullable() });
const StaffParam = z.object({ id: z.uuid() });

function audit(sql: Parameters<typeof issueSession>[0], member: { id: string; merchantId: string; name: string; role: string }, action: string, details: Record<string, string | number | boolean> = {}) {
  return sql`insert into audit_log (merchant_id, actor_type, actor_id, actor_name, actor_role, action, target_kind, target_id, details) values (${member.merchantId}, 'staff', ${member.id}, ${member.name}, ${member.role}, ${action}, 'staff', ${member.id}, ${JSON.stringify(details)}::jsonb)`;
}

export function identityRoutes(app: OpenAPIHono<AppEnv>) {
  defineOp(app, { op: "auth.status", method: "get", path: "/v1/auth/status", tags: ["auth"], responses: { 200: jsonResponse(dataResponse(z.object({ provider: z.enum(["local", "oidc"]), setup_required: z.boolean() }))), ...errorResponses } }, async (c) => {
    const [row] = await withTransaction((t) => t.sql<{ any: boolean }[]>`select exists (select 1 from merchants) as any`);
    return c.json({ data: { provider: identityProviderKind(), setup_required: !row!.any } }, 200);
  });

  defineOp(app, { op: "auth.sign_in", method: "post", path: "/v1/auth/sign-in", tags: ["auth"], request: { body: jsonBody(z.object({ email: z.string().min(1).max(320), password: Password })) }, responses: { 201: jsonResponse(dataResponse(SessionOut)), ...errorResponses } }, async (c) => {
    requireLocal("Password sign-in");
    const body = c.req.valid("json");
    const email = normaliseEmail(body.email);
    // Counted before the password is checked, in Postgres, so concurrent guesses and other API machines all add up.
    await takePinAttempt(NO_MERCHANT, `signin-address:${clientAddress(c)}`, ADDRESS_LIMITS);
    await takePinAttempt(NO_MERCHANT, emailScope(email), EMAIL_LIMITS);
    type Row = { password_hash: string | null; id: string; merchant_id: string; name: string; role: "server" | "cashier" | "manager" | "finance" | "admin"; active: boolean; auth_subject: string | null };
    const signedIn = await withTransaction(async (t) => {
      const [row] = await t.sql<Row[]>`select l.password_hash, s.id, s.merchant_id, s.name, s.role, s.active, s.auth_subject from backoffice_logins l join staff s on s.id = l.staff_id where l.email = ${email}`;
      // Always one scrypt comparison, whether or not the email exists or has a password.
      const match = verifySecret(body.password, row?.password_hash ?? noHash());
      if (!match || !row || !row.password_hash || !row.active || row.auth_subject !== localSubject(row.id)) return null;
      const member = { id: row.id, merchantId: row.merchant_id, name: row.name, role: row.role };
      const session = await issueSession(t.sql, member);
      await audit(t.sql, member, "auth.sign_in");
      return { session, member };
    });
    if (!signedIn) throw notRecognised();
    // A right password clears the email's count but never a lock, and never the address's count.
    await clearPinFailures(NO_MERCHANT, emailScope(email));
    return c.json({ data: { ...signedIn.session, staff: { id: signedIn.member.id, name: signedIn.member.name, role: signedIn.member.role } } }, 201);
  });

  defineOp(app, { op: "auth.sign_out", method: "post", path: "/v1/auth/sign-out", tags: ["auth"], request: { body: jsonBody(z.object({}).passthrough()) }, responses: { 200: jsonResponse(mutationResponse(z.object({ ended: z.boolean() }))), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const sessionId = p.type === "staff" ? p.backofficeSessionId : undefined;
    if (!sessionId) return c.json({ data: { ended: false }, events: [], warnings: ["Nothing to end: this is not a back-office session issued by this server."] }, 200);
    await db().update(backofficeSessions).set({ endedAt: new Date() }).where(and(eq(backofficeSessions.id, sessionId), eq(backofficeSessions.merchantId, p.merchantId)));
    await recordAudit(p, { action: "auth.sign_out", targetKind: "staff", targetId: p.id });
    return c.json({ data: { ended: true }, events: [], warnings: [] }, 200);
  });

  defineOp(app, { op: "auth.change_password", method: "post", path: "/v1/auth/password", tags: ["auth"], request: { body: jsonBody(z.object({ current_password: Password, new_password: Password })) }, responses: { 200: jsonResponse(mutationResponse(z.object({ changed: z.boolean(), sessions_ended: z.number().int() }))), ...errorResponses } }, async (c) => {
    requireLocal("Password change");
    const p = c.get("principal");
    if (p.type !== "staff" || !p.backofficeSessionId) throw new AppError("permission_denied", "Change your password from a back-office session", { remedy: "Sign in to the back office with your email and password." });
    const body = c.req.valid("json");
    checkPassword(body.new_password);
    const [login] = await db().select({ email: backofficeLogins.email }).from(backofficeLogins).where(and(eq(backofficeLogins.staffId, p.id), eq(backofficeLogins.merchantId, p.merchantId))).limit(1);
    if (!login) throw new AppError("unauthenticated", "Your back-office session has ended", { remedy: "Sign in again." });
    await takePinAttempt(NO_MERCHANT, emailScope(login.email), EMAIL_LIMITS);
    // Hashes are read and written as the connection owner: request roles have no access to them.
    const ended = await withOwnTransaction(async (sql) => {
      const [row] = await sql<{ password_hash: string | null }[]>`select password_hash from backoffice_logins where staff_id = ${p.id} and merchant_id = ${p.merchantId} for update`;
      if (!verifySecret(body.current_password, row?.password_hash ?? noHash()) || !row?.password_hash) return null;
      await sql`update backoffice_logins set password_hash = ${hashSecret(body.new_password)}, password_changed_at = now() where staff_id = ${p.id}`;
      const others = await sql`update backoffice_sessions set ended_at = now() where staff_id = ${p.id} and ended_at is null and id <> ${p.backofficeSessionId!} returning id`;
      // A reset link issued before the change must not undo it.
      await sql`update backoffice_links set revoked_at = now() where staff_id = ${p.id} and used_at is null and revoked_at is null`;
      return others.length;
    });
    if (ended == null) throw AppError.validation("Your current password is not right", { remedy: "Type your current password again. After 5 wrong attempts the email is locked for 15 minutes." });
    await clearPinFailures(NO_MERCHANT, emailScope(login.email));
    await recordAudit(p, { action: "auth.change_password", targetKind: "staff", targetId: p.id, details: { sessions_ended: ended } });
    return c.json({ data: { changed: true, sessions_ended: ended }, events: [], warnings: [] }, 200);
  });

  defineOp(app, { op: "auth.accept_link", method: "post", path: "/v1/auth/links/accept", tags: ["auth"], request: { body: jsonBody(z.object({ token: secret(z.string().min(1).max(200)), password: Password })) }, responses: { 201: jsonResponse(dataResponse(SessionOut)), ...errorResponses } }, async (c) => {
    requireLocal("Password links");
    const body = c.req.valid("json");
    checkPassword(body.password);
    const signedIn = await withTransaction(async (t) => {
      // Single use: the first request to mark the link used wins; a concurrent second one finds nothing.
      const [link] = await t.sql<{ id: string; staff_id: string; merchant_id: string; kind: "invite" | "reset" }[]>`update backoffice_links set used_at = now()
        where token_hash = ${sha256(body.token)} and used_at is null and revoked_at is null and expires_at > now() returning id, staff_id, merchant_id, kind`;
      if (!link) return null;
      const [row] = await t.db.select().from(staff).where(and(eq(staff.id, link.staff_id), eq(staff.merchantId, link.merchant_id), eq(staff.active, true))).limit(1);
      if (!row) return null;
      const [login] = await t.db.select({ email: backofficeLogins.email }).from(backofficeLogins).where(eq(backofficeLogins.staffId, row.id)).limit(1);
      // A reset keeps the login's email; an invitation signs in with the email on the staff record.
      const email = link.kind === "reset" ? login?.email : row.email;
      if (!email || (link.kind === "reset" && row.authSubject !== localSubject(row.id))) return null;
      const member = { id: row.id, merchantId: row.merchantId, name: row.name, role: row.role };
      await setLocalLogin(t.sql, member, email, body.password);
      await endSessions(t.sql, row.id);
      await t.sql`update backoffice_links set revoked_at = now() where staff_id = ${row.id} and used_at is null and revoked_at is null`;
      const session = await issueSession(t.sql, member);
      await audit(t.sql, member, "auth.accept_link", { kind: link.kind });
      return { session, member };
    });
    if (!signedIn) throw linkUnusable();
    return c.json({ data: { ...signedIn.session, staff: { id: signedIn.member.id, name: signedIn.member.name, role: signedIn.member.role } } }, 201);
  });

  const SetupIn = z.object({
    business_name: z.string().trim().min(1).max(120),
    preset: RegionPresetKeySchema,
    time_zone: z.string().min(1).max(64),
    currency: z.string().length(3).optional(),
    locale: z.string().min(2).max(35).optional(),
    outlet_name: z.string().trim().min(1).max(120),
    admin: z.object({ name: z.string().trim().min(1).max(120), email: z.email().max(320), password: Password.optional() }),
  });
  defineOp(app, { op: "setup.create", method: "post", path: "/v1/setup", tags: ["auth"], request: { body: jsonBody(SetupIn) }, responses: { 201: jsonResponse(dataResponse(z.object({ merchant_id: z.string(), outlet_id: z.string(), station_id: z.string(), admin_staff_id: z.string(), provider: z.enum(["local", "oidc"]), session: SessionOut.nullable() }))), ...errorResponses } }, async (c) => {
    const b = c.req.valid("json");
    const local = identityProviderKind() === "local";
    if (local) {
      if (!b.admin.password) throw AppError.validation("The first Admin needs a password", { remedy: "Choose a password of at least 12 characters." });
      checkPassword(b.admin.password);
    }
    const input = { merchantName: b.business_name, outletName: b.outlet_name, preset: b.preset, timeZone: b.time_zone, currency: b.currency, locale: b.locale, admin: { name: b.admin.name, email: b.admin.email, password: local ? b.admin.password : undefined } };
    try {
      presetSettings(REGION_PRESETS[b.preset], input);
    } catch (e) {
      throw AppError.validation((e as Error).message, { remedy: "Pick a valid time zone; the blank preset also needs a currency and locale." });
    }
    // Refuse from the shared pool first, so a set-up server never opens a connection for this public route.
    const [done] = await withTransaction((t) => t.sql<{ any: boolean }[]>`select exists (select 1 from merchants) as any`);
    if (done!.any) throw alreadySetUp();
    // Its own connection, as the CLI bootstrap uses: the preset writes arrays, which the shared pool's Drizzle serialisers do not take.
    const sql = sessionConnection();
    const result = await sql
      .begin(async (t) => {
        // One setup at a time: a concurrent second request waits here, then sees the first one's merchant.
        await t`select pg_advisory_xact_lock(hashtext('sail.setup'))`;
        const [existing] = await t<{ any: boolean }[]>`select exists (select 1 from merchants) as any`;
        if (existing!.any) throw alreadySetUp();
        const r = await createMerchant(t, input);
        const admin = { id: r.adminStaffId, merchantId: r.merchantId, name: b.admin.name, role: "admin" as const };
        const session = local ? await issueSession(t, admin) : null;
        await audit(t, admin, "setup.create", { preset: b.preset });
        return { r, session: session ? { ...session, staff: { id: admin.id, name: admin.name, role: admin.role } } : null };
      })
      .finally(() => sql.end({ timeout: 5 }));
    return c.json({ data: { merchant_id: result.r.merchantId, outlet_id: result.r.outletId, station_id: result.r.stationId, admin_staff_id: result.r.adminStaffId, provider: identityProviderKind(), session: result.session } }, 201);
  });

  async function memberOf(c: AppContext, id: string) {
    const p = c.get("principal");
    // From a back-office session only: an Admin's 6-digit POS PIN, seen over a shoulder at a station, must not mint sign-in links.
    if (p.type !== "staff" || p.via !== "backoffice") throw new AppError("permission_denied", "Manage back-office access from the back office", { remedy: "Sign in to the back office with your email." });
    const [row] = await db().select().from(staff).where(and(eq(staff.id, id), eq(staff.merchantId, p.merchantId))).limit(1);
    if (!row) throw AppError.notFound("staff member", id);
    return row;
  }

  async function accessOf(row: typeof staff.$inferSelect): Promise<z.infer<typeof AccessOut>> {
    const provider = identityProviderKind();
    const [[login], [link]] = await Promise.all([
      db().select({ email: backofficeLogins.email }).from(backofficeLogins).where(eq(backofficeLogins.staffId, row.id)).limit(1),
      db()
        .select({ kind: backofficeLinks.kind, expiresAt: backofficeLinks.expiresAt })
        .from(backofficeLinks)
        .where(and(eq(backofficeLinks.staffId, row.id), isNull(backofficeLinks.usedAt), isNull(backofficeLinks.revokedAt), gt(backofficeLinks.expiresAt, new Date())))
        .limit(1),
    ]);
    const invited = provider === "local" ? link?.kind === "invite" : login !== undefined;
    return {
      provider,
      status: row.authSubject ? "active" : invited ? "invited" : "none",
      email: login?.email ?? row.email,
      link: link ? { kind: link.kind as "invite" | "reset", expires_at: link.expiresAt.toISOString() } : null,
    };
  }

  /** A new single-use link for a staff member; earlier open links stop working. Returned once (see the idempotency note in middleware). */
  async function newLink(c: AppContext, row: typeof staff.$inferSelect, kind: "invite" | "reset") {
    const p = c.get("principal");
    await tx()`update backoffice_links set revoked_at = now() where staff_id = ${row.id} and used_at is null and revoked_at is null`;
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + (kind === "invite" ? INVITE_DAYS * 24 : RESET_HOURS) * 3600 * 1000);
    await db().insert(backofficeLinks).values({ merchantId: row.merchantId, staffId: row.id, kind, tokenHash: sha256(token), createdBy: p.id, expiresAt });
    // The token travels in the fragment, which browsers never send to a server or put in a Referer header.
    return { url: `${config().WEB_APP_URL.replace(/\/+$/, "")}/set-password#token=${token}`, expiresAt };
  }

  defineOp(app, { op: "staff.access", method: "get", path: "/v1/staff/{id}/access", tags: ["team"], request: { params: StaffParam }, responses: { 200: jsonResponse(dataResponse(AccessOut)), ...errorResponses } }, async (c) => {
    const row = await memberOf(c, c.req.valid("param").id);
    return c.json({ data: await accessOf(row) }, 200);
  });

  defineOp(app, { op: "staff.invite", method: "post", path: "/v1/staff/{id}/invite", tags: ["team"], request: { params: StaffParam, body: jsonBody(z.object({}).passthrough()) }, responses: { 201: jsonResponse(mutationResponse(LinkOut)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const row = await memberOf(c, c.req.valid("param").id);
    if (!row.active) throw AppError.state("Inactive staff cannot be invited", [], "Make them active first.");
    if (!row.email) throw AppError.validation("This staff member has no email", { remedy: "Add their email, save, then invite them." });
    if (row.authSubject) throw AppError.state("This person can already sign in to the back office", [], "Generate a reset link instead, or revoke their access first.");
    const email = normaliseEmail(row.email);
    // Sign-in starts from the email alone, so one email signs in to one staff record on the whole server.
    const taken = await withOwnTransaction((sql) => sql`select 1 from backoffice_logins where email = ${email} and staff_id <> ${row.id}`);
    if (taken.length > 0) throw AppError.state("This email already signs in to the back office on this server", [], "Use a different email for this staff member.");
    let out: z.infer<typeof LinkOut>;
    if (identityProviderKind() === "local") {
      const link = await newLink(c, row, "invite");
      out = { kind: "link", email, url: link.url, expires_at: link.expiresAt.toISOString() };
    } else {
      await db().delete(backofficeLogins).where(eq(backofficeLogins.staffId, row.id));
      await preAuthoriseLogin(tx(), row, email);
      out = { kind: "pre_authorised", email, url: null, expires_at: null };
    }
    await recordAudit(p, { action: "staff.invite", targetKind: "staff", targetId: row.id, details: { email, kind: out.kind } });
    return c.json({ data: out, events: [], warnings: out.url ? ["Copy the link now; it is not shown again."] : [] }, 201);
  });

  defineOp(app, { op: "staff.reset_password", method: "post", path: "/v1/staff/{id}/password-reset", tags: ["team"], request: { params: StaffParam, body: jsonBody(z.object({}).passthrough()) }, responses: { 201: jsonResponse(mutationResponse(LinkOut)), ...errorResponses } }, async (c) => {
    requireLocal("Password reset");
    const p = c.get("principal");
    const row = await memberOf(c, c.req.valid("param").id);
    if (!row.active) throw AppError.state("Inactive staff cannot reset a password", [], "Make them active first.");
    if (row.authSubject !== localSubject(row.id)) throw AppError.state("This person has no back-office password yet", [], "Invite them instead.");
    const [login] = await db().select({ email: backofficeLogins.email }).from(backofficeLogins).where(eq(backofficeLogins.staffId, row.id)).limit(1);
    const link = await newLink(c, row, "reset");
    await recordAudit(p, { action: "staff.reset_password", targetKind: "staff", targetId: row.id });
    return c.json({ data: { kind: "link" as const, email: login?.email ?? row.email ?? "", url: link.url, expires_at: link.expiresAt.toISOString() }, events: [], warnings: ["Copy the link now; it is not shown again."] }, 201);
  });

  defineOp(app, { op: "staff.revoke_access", method: "post", path: "/v1/staff/{id}/revoke-access", tags: ["team"], request: { params: StaffParam, body: jsonBody(z.object({}).passthrough()) }, responses: { 200: jsonResponse(mutationResponse(AccessOut)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const row = await memberOf(c, c.req.valid("param").id);
    if (row.id === p.id) throw AppError.invariant("admin_self_revoke", "You cannot revoke your own back-office access", "Ask another Admin.");
    await db().delete(backofficeLogins).where(and(eq(backofficeLogins.staffId, row.id), eq(backofficeLogins.merchantId, p.merchantId)));
    const [updated] = await db().update(staff).set({ authSubject: null, updatedAt: new Date() }).where(and(eq(staff.id, row.id), eq(staff.merchantId, p.merchantId))).returning();
    await db().update(backofficeSessions).set({ endedAt: new Date() }).where(and(eq(backofficeSessions.staffId, row.id), isNull(backofficeSessions.endedAt)));
    await db().update(backofficeLinks).set({ revokedAt: new Date() }).where(and(eq(backofficeLinks.staffId, row.id), isNull(backofficeLinks.usedAt), isNull(backofficeLinks.revokedAt)));
    await recordAudit(p, { action: "staff.revoke_access", targetKind: "staff", targetId: row.id });
    return c.json({ data: await accessOf(updated!), events: [], warnings: [] }, 200);
  });
}

