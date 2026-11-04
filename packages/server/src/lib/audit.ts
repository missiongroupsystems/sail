import { db } from "../db/client.js";
import { auditLog } from "../db/schema/index.js";
import type { Principal } from "../auth/principal.js";
import { principalRole } from "../auth/principal.js";

export type AuditInput = {
  action: string;
  targetKind: string;
  targetId?: string | null;
  outletId?: string | null;
  details?: Record<string, unknown>;
  reason?: string | null;
  approver?: { id: string; name?: string | null } | null;
  overrideId?: string | null;
};

/**
 * The single server-side audit writer (scope doc 4.1). Every restricted or
 * money-affecting action calls this inside its transaction.
 */
export async function recordAudit(principal: Principal, input: AuditInput): Promise<void> {
  await db()
    .insert(auditLog)
    .values({
      merchantId: principal.merchantId,
      outletId: input.outletId ?? ("outletId" in principal ? (principal.outletId ?? null) : null),
      actorType: principal.type,
      actorId: principal.id,
      actorName: "name" in principal ? principal.name : null,
      actorRole: principalRole(principal),
      onBehalfOf: principal.type === "agent" ? principal.onBehalfOf : null,
      action: input.action,
      targetKind: input.targetKind,
      targetId: input.targetId ?? null,
      approverId: input.approver?.id ?? null,
      approverName: input.approver?.name ?? null,
      overrideId: input.overrideId ?? null,
      reason: input.reason ?? null,
      details: input.details ?? {},
    });
}
