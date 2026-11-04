import { and, eq, gt, isNull } from "drizzle-orm";
import { roleAtLeast, type Role } from "@sail/shared";
import { db } from "../db/client.js";
import { overrides, staff } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import { verifySecret } from "../auth/tokens.js";
import type { Principal } from "../auth/principal.js";

export const OVERRIDE_TTL_SECONDS = 120;

/**
 * Manager override (scope doc 4.1, 7.1 rule 9): a Manager+ PIN authorises a
 * single restricted action without switching the signed-in user. The grant is
 * bound to one action and target, used once, and expires.
 */
export async function grantOverride(requester: Principal, input: { action: string; targetKind: string; targetId: string; approverPin: string; outletId: string; requiredRole: Role }) {
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
      approverId: approver.id,
      approverName: approver.name,
      approverRole: approver.role,
      requesterId: requester.id,
      requesterName: "name" in requester ? requester.name : null,
      expiresAt: new Date(Date.now() + OVERRIDE_TTL_SECONDS * 1000),
    })
    .returning();
  return { grant: row!, approver };
}

/** Consume a grant for `action` on `target`. Returns the approver for the audit trail. */
export async function consumeOverride(overrideId: string, action: string, targetId: string, principal: Principal): Promise<{ id: string; name: string | null; role: string }> {
  const [row] = await db()
    .select()
    .from(overrides)
    .where(and(eq(overrides.id, overrideId), eq(overrides.merchantId, principal.merchantId), isNull(overrides.usedAt), gt(overrides.expiresAt, new Date())))
    .limit(1);
  if (!row) throw new AppError("permission_denied", "Manager approval is missing, used or expired", { remedy: "Ask a manager to approve the action again.", details: { override_id: overrideId } });
  if (row.action !== action || row.targetId !== targetId) {
    throw new AppError("permission_denied", "Manager approval was for a different action", { remedy: "Ask a manager to approve this action.", details: { approved_action: row.action, approved_target: row.targetId, action, target: targetId } });
  }
  await db().update(overrides).set({ usedAt: new Date(), usedBy: principal.id }).where(eq(overrides.id, overrideId));
  return { id: row.approverId, name: row.approverName, role: row.approverRole };
}

/**
 * Role check with optional override: returns the approver when an override
 * grant was used, null when the role sufficed, and throws otherwise.
 */
export async function requireRoleOrOverride(principal: Principal, role: Role | null, required: Role, opts: { action: string; targetId: string; overrideId?: string | null; overrideAllowed: boolean }) {
  if (role && roleAtLeast(role, required)) return null;
  if (!opts.overrideAllowed || !opts.overrideId) throw AppError.permission(required, opts.overrideAllowed, opts.action);
  return consumeOverride(opts.overrideId, opts.action, opts.targetId, principal);
}
