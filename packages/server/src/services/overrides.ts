import { and, eq, gt, isNull } from "drizzle-orm";
import { roleAtLeast, type Role } from "@sail/shared";
import { db } from "../db/client.js";
import { overrides, staff } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import { verifySecret } from "../auth/tokens.js";
import type { Principal } from "../auth/principal.js";

export const OVERRIDE_TTL_SECONDS = 120;

/** The arguments of the protected request that the approver saw (the void quantity, the refund and its quoted total, ...). */
export type OverrideArgs = Record<string, unknown>;

/** JSON with sorted keys and without undefined members, so equal arguments compare equal however they were built or stored. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

const sessionOf = (p: Principal) => (p.type === "staff" ? (p.sessionId ?? null) : null);
const stationOf = (p: Principal) => (p.type === "staff" ? (p.stationId ?? null) : null);

/**
 * Manager override (scope doc 4.1, 7.1 rule 9): a PIN of the required role
 * authorises a single restricted action without switching the signed-in user.
 * The grant is bound to the action, its target, the arguments the approver
 * saw and the requesting staff session and station; it is used once and expires.
 */
export async function grantOverride(requester: Extract<Principal, { type: "staff" }>, input: { action: string; targetKind: string; targetId: string; approverPin: string; outletId: string; requiredRole: Role; args: OverrideArgs }) {
  const candidates = await db()
    .select()
    .from(staff)
    .where(and(eq(staff.merchantId, requester.merchantId), eq(staff.active, true)));
  const approver = candidates.find((s) => roleAtLeast(s.role, input.requiredRole) && (s.outletIds.length === 0 || s.outletIds.includes(input.outletId)) && verifySecret(input.approverPin, s.pinHash));
  if (!approver) throw new AppError("permission_denied", "PIN not recognised for a manager at this outlet", { remedy: `Ask a ${input.requiredRole} or above to enter their PIN.`, details: { required_role: input.requiredRole } });
  if (approver.id === requester.id) throw new AppError("permission_denied", "You cannot approve your own action", { remedy: "Ask another manager to approve it." });
  const [row] = await db()
    .insert(overrides)
    .values({
      merchantId: requester.merchantId,
      outletId: input.outletId,
      action: input.action,
      targetKind: input.targetKind,
      targetId: input.targetId,
      args: input.args,
      approverId: approver.id,
      approverName: approver.name,
      approverRole: approver.role,
      requesterId: requester.id,
      requesterName: requester.name,
      requesterSessionId: requester.sessionId ?? null,
      stationId: requester.stationId ?? null,
      expiresAt: new Date(Date.now() + OVERRIDE_TTL_SECONDS * 1000),
    })
    .returning();
  return { grant: row!, approver };
}

/** Consume a grant for exactly this action, target and arguments, by the session that asked, with an approver of at least `required`. Returns the approver for the audit trail. */
export async function consumeOverride(overrideId: string, want: { action: string; targetId: string; required: Role; args: OverrideArgs }, principal: Principal): Promise<{ id: string; name: string | null; role: string }> {
  const [row] = await db()
    .select()
    .from(overrides)
    .where(and(eq(overrides.id, overrideId), eq(overrides.merchantId, principal.merchantId), isNull(overrides.usedAt), gt(overrides.expiresAt, new Date())))
    .limit(1);
  const missing = () => new AppError("permission_denied", "Manager approval is missing, used or expired", { remedy: "Ask a manager to approve the action again.", details: { override_id: overrideId } });
  if (!row) throw missing();
  if (row.requesterId !== principal.id || row.requesterSessionId !== sessionOf(principal) || row.stationId !== stationOf(principal)) {
    throw new AppError("permission_denied", "Manager approval was given to someone else", { remedy: "Ask a manager to approve the action for you." });
  }
  if (row.action !== want.action || row.targetId !== want.targetId || canonical(row.args) !== canonical(want.args)) {
    throw new AppError("permission_denied", "Manager approval was for a different action", { remedy: "Ask a manager to approve exactly this action.", details: { approved_action: row.action, approved_target: row.targetId, approved_args: row.args, action: want.action, target: want.targetId, args: want.args } });
  }
  if (!roleAtLeast(row.approverRole as Role, want.required)) {
    throw new AppError("permission_denied", `Manager approval needs a ${want.required} or above`, { remedy: `Ask a ${want.required} or above to approve it.`, details: { required_role: want.required } });
  }
  // Conditional on still being unused: of two requests racing on one grant, only one gets the row.
  const used = await db()
    .update(overrides)
    .set({ usedAt: new Date(), usedBy: principal.id })
    .where(and(eq(overrides.id, overrideId), isNull(overrides.usedAt), gt(overrides.expiresAt, new Date())))
    .returning({ id: overrides.id });
  if (used.length === 0) throw missing();
  return { id: row.approverId, name: row.approverName, role: row.approverRole };
}

/**
 * Role check with optional override: returns the approver when an override
 * grant was used, null when the role sufficed, and throws otherwise.
 */
export async function requireRoleOrOverride(principal: Principal, role: Role | null, required: Role, opts: { action: string; targetId: string; args: OverrideArgs; overrideId?: string | null; overrideAllowed: boolean }) {
  if (role && roleAtLeast(role, required)) return null;
  if (!opts.overrideAllowed || !opts.overrideId) throw AppError.permission(required, opts.overrideAllowed, opts.action);
  return consumeOverride(opts.overrideId, { action: opts.action, targetId: opts.targetId, required, args: opts.args }, principal);
}
