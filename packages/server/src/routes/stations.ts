import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq, gt, isNull } from "drizzle-orm";
import { PERMISSIONS, RoleSchema, registerOperations, type Role } from "@sail/shared";
import { db, withTransaction } from "../db/client.js";
import { auditLog, orderManualApplications, staff, staffSessions, stationPairingCodes, stations } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import type { AppEnv } from "../lib/context.js";
import { dataResponse, defineOp, errorResponses, jsonBody, jsonResponse, mutationResponse, z, untrusted, secret } from "../lib/openapi.js";
import { appendEvent } from "../lib/events.js";
import { recordAudit } from "../lib/audit.js";
import { hashSecret, pinLookup, randomDigits, randomToken, sha256, signSailToken, verifySecret } from "../auth/tokens.js";
import { grantOverride } from "../services/overrides.js";
import { paymentRole } from "../services/payments.js";
import { activeRules, ruleOrLastVersion } from "../services/pricing-rules.js";
import { quote, refundableFor } from "../services/refunds.js";
import { RefundRequestSchema, TenderSplit } from "./splits-refunds.js";
import { clearPinFailures, pinScope, takePinAttempt } from "../services/pin-attempts.js";
import { businessDayInputs, toStation } from "./org.js";
import { config } from "../config.js";

registerOperations({
  "stations.pairing_code": { op: "stations.pairing_code", summary: "Issue a one-time pairing code for a station", description: "Admin only. The 6-digit code is shown once and expires in 10 minutes. The iPad enters it in stations.pair.", tier: "T3", minRole: "admin", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff"], emits: ["station.pairing_code_issued"], mcp: { expose: false, toolsets: [] } },
  "stations.pair": { op: "stations.pair", summary: "Pair an iPad to a station", description: "Exchanges a one-time pairing code for a long-lived station token. No authentication; the code is single-use. Pairing again replaces the previous token.", tier: "T3", minRole: null, overrideAllowed: false, reasonRequired: false, dryRun: false, principals: [], emits: ["station.paired"], mcp: { expose: false, toolsets: [] } },
  "staff_sessions.start": { op: "staff_sessions.start", summary: "Sign in on a station with a PIN", description: "Station token plus 6-digit PIN → a short-lived PIN session token for the staff member. Lockout after repeated failures. The session ends after inactivity.", tier: "T0", minRole: null, overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["station"], emits: ["staff_session.started"], mcp: { expose: false, toolsets: [] } },
  "staff_sessions.end": { op: "staff_sessions.end", summary: "Sign out of a station", description: "Ends the current PIN session.", tier: "T1", minRole: null, overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff"], emits: ["staff_session.ended"], mcp: { expose: false, toolsets: [] } },
  "overrides.grant": { op: "overrides.grant", summary: "Manager override: approve one restricted action", description: "A Manager+ (or, for a manual pricing rule, a user of the rule's own minimum role) enters their PIN to authorise one action for the signed-in staff member, without switching users. Send the action, its target and `args`: the arguments the approver is shown (the void quantity, the open-price lines, the rule, entered value and lines, the payment, the refund request and its total, nothing for a reopen). For a refund, `args.total` is the quoted total shown to the approver; the register refuses the grant when its own quote differs. Returns a single-use grant valid for 2 minutes, bound to all of that and to the requesting PIN session and station. Pass it as `override_id` on the protected request, whose arguments must match exactly. The grant id is returned only here: it is not on the event log or the audit trail. Wrong PINs count towards the station's sign-in lockout (5 wrong PINs, sign-in and approval together, lock the station for 30 seconds).", tier: "T0", minRole: null, overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff"], emits: ["override.granted"], mcp: { expose: true, toolsets: ["pos.order"] } },
});

/** One variant per action a manager may approve: its target kind and the arguments the approver sees, which the protected request must repeat exactly. */
const grantBase = { target_id: z.uuid(), approver_pin: secret(z.string().regex(/^\d{6}$/)), outlet_id: z.uuid().optional() };
const GrantRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("lines.void_fired"), target_kind: z.literal("order_line"), ...grantBase, args: z.object({ quantity: z.number().int().min(1) }) }),
  z.object({ action: z.literal("lines.add_open_price"), target_kind: z.literal("order"), ...grantBase, args: z.object({ lines: z.array(z.object({ line_id: z.uuid(), product_id: z.uuid(), quantity: z.number().int().min(1), open_price: z.number().int().min(0) })).min(1) }) }),
  z.object({ action: z.literal("adjustments.apply_manual"), target_kind: z.literal("order"), ...grantBase, args: z.object({ rule_key: z.string().min(1), entered_value: z.number().int().min(0).nullable(), line_ids: z.array(z.uuid()).min(1).nullable() }) }),
  z.object({ action: z.literal("adjustments.remove"), target_kind: z.literal("order"), ...grantBase, args: z.object({ application_id: z.uuid() }) }),
  z.object({ action: z.literal("payments.record"), target_kind: z.literal("order"), ...grantBase, args: z.object({ check_id: z.uuid(), tender_type_id: z.uuid(), amount: z.number().int().min(1), tip_cents: z.number().int().min(0), reference: untrusted(z.string().max(80).nullable().default(null)) }) }),
  z.object({ action: z.literal("refunds.create"), target_kind: z.literal("check"), ...grantBase, args: z.object({ request: RefundRequestSchema, tender_split: TenderSplit, total: z.number().int().min(0) }) }),
  z.object({ action: z.literal("orders.reopen"), target_kind: z.literal("order"), ...grantBase, args: z.object({}) }),
  z.object({ action: z.literal("payments.void"), target_kind: z.literal("payment"), ...grantBase, args: z.object({ amount: z.number().int().min(1) }) }),
]);

export function stationRoutes(app: OpenAPIHono<AppEnv>) {
  defineOp(app, { op: "stations.pairing_code", method: "post", path: "/v1/stations/{id}/pairing-code", tags: ["stations"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(z.object({}).passthrough()) }, responses: { 201: jsonResponse(mutationResponse(z.object({ code: secret(z.string()), expires_at: z.string() }))), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const [st] = await db().select().from(stations).where(and(eq(stations.id, id), eq(stations.merchantId, p.merchantId), isNull(stations.archivedAt))).limit(1);
    if (!st) throw AppError.notFound("station", id);
    const code = randomDigits(6);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await db().insert(stationPairingCodes).values({ merchantId: p.merchantId, stationId: id, codeHash: hashSecret(code), createdBy: p.id, expiresAt });
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: st.outletId, type: "station.pairing_code_issued", aggregate: { kind: "station", id }, operationId: "stations.pairing_code", payload: { expires_at: expiresAt.toISOString() }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: await businessDayInputs(p.merchantId, st.outletId) }, p);
    await recordAudit(p, { action: "stations.pairing_code", targetKind: "station", targetId: id, outletId: st.outletId });
    return c.json({ data: { code, expires_at: expiresAt.toISOString() }, events: [ev], warnings: [] }, 201);
  });

  defineOp(app, { op: "stations.pair", method: "post", path: "/v1/stations/pair", tags: ["stations"], request: { body: jsonBody(z.object({ code: secret(z.string().regex(/^\d{6}$/)), device_label: untrusted(z.string().min(1).max(80)), kind: z.enum(["pos", "display"]).optional().describe("The kind of station this device expects (the kitchen display sends display). Another kind is refused before the code is used, so the station's current device stays paired.") })) }, responses: { 200: jsonResponse(dataResponse(z.object({ station_token: secret(z.string()), station: z.record(z.string(), z.unknown()) }))), ...errorResponses } }, async (c) => {
    const { code, device_label, kind } = c.req.valid("json");
    // Public route: runs its own transaction as the connection owner (no principal yet).
    const result = await withTransaction(async (t) => {
      const candidates = await t.db.select().from(stationPairingCodes).where(and(isNull(stationPairingCodes.usedAt), gt(stationPairingCodes.expiresAt, new Date())));
      const match = candidates.find((x) => verifySecret(code, x.codeHash));
      if (!match) throw new AppError("unauthenticated", "Pairing code not recognised or expired", { remedy: "Ask an Admin for a new code from the station's page in the back office." });
      if (kind) {
        const [target] = await t.db.select({ kind: stations.kind }).from(stations).where(eq(stations.id, match.stationId)).limit(1);
        if (target && target.kind !== kind) throw AppError.validation(`This code is for a ${target.kind === "display" ? "kitchen display" : "POS"} station`, { remedy: target.kind === "display" ? "Open /kds on the screen and enter the code there." : "Use a code from a kitchen display station, or open /pos on the iPad." });
      }
      const token = await signSailToken({ typ: "station", merchant_id: match.merchantId, station_id: match.stationId }, null);
      await t.db.update(stationPairingCodes).set({ usedAt: new Date() }).where(eq(stationPairingCodes.id, match.id));
      const [st] = await t.db.update(stations).set({ tokenHash: sha256(token), pairedAt: new Date(), deviceLabel: device_label }).where(eq(stations.id, match.stationId)).returning();
      await appendEvent({ merchantId: st!.merchantId, outletId: st!.outletId, type: "station.paired", aggregate: { kind: "station", id: st!.id }, operationId: "stations.pair", payload: { device_label }, actor: { principal_type: "station", principal_id: st!.id, role: null }, correlationId: c.get("correlationId") });
      await t.db.insert(auditLog).values({ merchantId: st!.merchantId, outletId: st!.outletId, actorType: "station", actorId: st!.id, action: "stations.pair", targetKind: "station", targetId: st!.id, details: { device_label } });
      return { token, station: st! };
    });
    return c.json({ data: { station_token: result.token, station: toStation(result.station) } }, 200);
  });

  defineOp(
    app,
    { op: "staff_sessions.start", method: "post", path: "/v1/stations/sessions", tags: ["stations"], request: { body: jsonBody(z.object({ pin: secret(z.string().regex(/^\d{6}$/)) })) }, responses: { 201: jsonResponse(dataResponse(z.object({ session_token: secret(z.string()), staff: z.object({ id: z.string(), name: z.string(), initials: z.string().nullable(), role: RoleSchema }), station: z.record(z.string(), z.unknown()), expires_in_seconds: z.number().int() }))), ...errorResponses } },
    async (c) => {
      const p = c.get("principal");
      if (p.type !== "station") throw new AppError("permission_denied", "Sign-in needs a station token", { remedy: "Pair this iPad to a station first." });
      const { pin } = c.req.valid("json");
      const scope = pinScope(p);
      await takePinAttempt(p.merchantId, scope);
      const [member] = await db().select().from(staff).where(and(eq(staff.merchantId, p.merchantId), eq(staff.pinLookup, pinLookup(p.merchantId, pin)), eq(staff.active, true))).limit(1);
      const ok = member && verifySecret(pin, member.pinHash) && (member.outletIds.length === 0 || member.outletIds.includes(p.outletId));
      if (!ok) {
        throw new AppError("unauthenticated", "PIN not recognised", { remedy: "Check your PIN. After 5 wrong attempts the station locks for 30 seconds." });
      }
      await clearPinFailures(p.merchantId, scope);
      const [sess] = await db().insert(staffSessions).values({ merchantId: p.merchantId, staffId: member.id, stationId: p.stationId, outletId: p.outletId }).returning();
      const idle = config().PIN_SESSION_IDLE_SECONDS;
      const token = await signSailToken({ typ: "pin", merchant_id: p.merchantId, outlet_id: p.outletId, station_id: p.stationId, staff_id: member.id, session_id: sess!.id, role: member.role }, 14 * 3600);
      const [st] = await db().select().from(stations).where(eq(stations.id, p.stationId)).limit(1);
      await appendEvent({ merchantId: p.merchantId, outletId: p.outletId, type: "staff_session.started", aggregate: { kind: "staff_session", id: sess!.id }, operationId: "staff_sessions.start", payload: { staff_id: member.id, station_id: p.stationId }, actor: { principal_type: "staff", principal_id: member.id, role: member.role, name: member.name, station_id: p.stationId }, correlationId: c.get("correlationId"), businessDay: await businessDayInputs(p.merchantId, p.outletId) });
      return c.json({ data: { session_token: token, staff: { id: member.id, name: member.name, initials: member.initials, role: member.role }, station: toStation(st!), expires_in_seconds: idle } }, 201);
    },
  );

  defineOp(app, { op: "staff_sessions.end", method: "post", path: "/v1/stations/sessions/end", tags: ["stations"], request: { body: jsonBody(z.object({}).passthrough()) }, responses: { 200: jsonResponse(mutationResponse(z.object({ ended: z.boolean() }))), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    if (p.type !== "staff" || !p.sessionId) throw AppError.validation("Not a PIN session");
    await db().update(staffSessions).set({ endedAt: new Date() }).where(eq(staffSessions.id, p.sessionId));
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: p.outletId!, type: "staff_session.ended", aggregate: { kind: "staff_session", id: p.sessionId }, operationId: "staff_sessions.end", correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: await businessDayInputs(p.merchantId, p.outletId) }, p);
    return c.json({ data: { ended: true }, events: [ev], warnings: [] }, 200);
  });

  defineOp(
    app,
    {
      op: "overrides.grant",
      method: "post",
      path: "/v1/overrides",
      tags: ["stations"],
      request: { body: jsonBody(GrantRequest) },
      responses: { 201: jsonResponse(mutationResponse(z.object({ override_id: z.string(), action: z.string(), target_id: z.string(), args: z.record(z.string(), z.unknown()), approver: z.object({ id: z.string(), name: z.string().nullable(), role: z.string() }), expires_at: z.string() }))), ...errorResponses },
    },
    async (c) => {
      const p = c.get("principal");
      if (p.type !== "staff") throw new AppError("permission_denied", "Overrides are requested by signed-in staff");
      const b = c.req.valid("json");
      const outletId = p.outletId ?? b.outlet_id;
      if (!outletId) throw AppError.validation("outlet_id is required when not on a station");
      let requiredRole: Role = PERMISSIONS[b.action].minRole;
      const args: Record<string, unknown> = b.args;
      if (b.action === "adjustments.apply_manual" || b.action === "adjustments.remove") {
        // The rule's own minimum role and override setting apply, not the operation's.
        let rule;
        if (b.action === "adjustments.apply_manual") rule = (await activeRules(p.merchantId, new Date())).find((r) => r.id === b.args.rule_key);
        else {
          const [app] = await db().select({ ruleKey: orderManualApplications.ruleKey }).from(orderManualApplications).where(and(eq(orderManualApplications.id, b.args.application_id), eq(orderManualApplications.orderId, b.target_id), isNull(orderManualApplications.removedAt))).limit(1);
          if (!app) throw AppError.notFound("adjustment", b.args.application_id);
          rule = await ruleOrLastVersion(p.merchantId, app.ruleKey, new Date());
        }
        if (!rule) throw AppError.notFound("pricing rule");
        if (!rule.override_allowed) throw new AppError("permission_denied", `${rule.name} cannot be authorised by override`, { remedy: "Only a user with the rule's role can do this.", details: { required_role: rule.min_role ?? "server" } });
        requiredRole = (rule.min_role ?? "server") as Role;
      }
      // A tender that requires approval needs a Manager's PIN, whatever the operation's own role.
      if (b.action === "payments.record") requiredRole = await paymentRole(p.merchantId, b.args.tender_type_id);
      if (b.action === "refunds.create") {
        // The approver is shown a total; the register's quote must agree, and the refund must later come to it.
        const total = quote(await refundableFor(b.target_id), b.args.request, b.args.tender_split).totals.total;
        if (total !== b.args.total) throw new AppError("state_conflict", "The refund total has changed since it was quoted", { remedy: "Quote the refund again and ask for approval with the new total.", details: { quoted_total: total, shown_total: b.args.total } });
      }
      const { grant, approver } = await grantOverride(p, { action: b.action, targetKind: b.target_kind, targetId: b.target_id, approverPin: b.approver_pin, outletId, requiredRole, args });
      // The grant id goes only to the requester: the event log and audit trail are readable by others, and the id is the bearer secret.
      const ev = await appendEvent({ merchantId: p.merchantId, outletId, type: "override.granted", aggregate: { kind: b.target_kind, id: b.target_id }, operationId: "overrides.grant", payload: { action: b.action, target_id: b.target_id }, approval: { approver_id: approver.id, approver_name: approver.name }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey"), businessDay: await businessDayInputs(p.merchantId, outletId) }, p);
      await recordAudit(p, { action: "overrides.grant", targetKind: b.target_kind, targetId: b.target_id, outletId, approver: { id: approver.id, name: approver.name }, details: { action: b.action, args } });
      return c.json({ data: { override_id: grant.id, action: grant.action, target_id: grant.targetId, args: grant.args, approver: { id: approver.id, name: approver.name, role: approver.role }, expires_at: grant.expiresAt.toISOString() }, events: [ev], warnings: [] }, 201);
    },
  );
}
