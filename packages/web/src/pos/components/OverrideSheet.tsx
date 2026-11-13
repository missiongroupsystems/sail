"use client";

import { Badge, PinPad, Sheet } from "@sail/ui";
import { useEffect, useState } from "react";
import { toApiError } from "@/lib/api";
import { grantOverride } from "../api/register";
import { useApi } from "../hooks/useApi";
import { ROLE_LABEL } from "../lib/format";
import { useUiStore } from "../state/ui";

/**
 * Manager approval, "Approve here": states the action and the
 * register's figures, takes the manager's PIN on the same iPad, then shows who
 * approved. The cashier stays signed in; the grant is for this one action.
 */
export function OverrideSheet() {
  const api = useApi();
  const request = useUiStore((s) => s.override);
  const settle = useUiStore((s) => s.settleOverride);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [approved, setApproved] = useState<string | null>(null);

  useEffect(() => {
    setPin("");
    setError(null);
    setApproved(null);
    setPending(false);
  }, [request]);

  const complete = async (value: string) => {
    if (!request) return;
    setPending(true);
    setError(null);
    try {
      const grant = await grantOverride(api, { ...request.subject, approver_pin: value });
      const name = grant.approver.name ?? "a manager";
      setApproved(`${name} (${ROLE_LABEL[grant.approver.role] ?? grant.approver.role})`);
      setTimeout(() => settle({ override_id: grant.override_id, approverName: name }), 700);
    } catch (e) {
      const err = toApiError(e);
      // The register's refusal is written for staff (what was refused, and who can approve it): shown as given.
      setError(`${err.message}${err.remedy ? ` ${err.remedy}` : ""}`);
      setPin("");
    } finally {
      setPending(false);
    }
  };

  return (
    <Sheet labelledClose isOpen={Boolean(request)} onOpenChange={(open) => (!open ? settle(null) : undefined)} title="Manager approval" description={request?.title} isDismissable={!pending}>
      {request ? (
        <div className="flex flex-col items-center gap-6">
          {/* What is being approved, as a bordered card with one row per part of the register's quote. */}
          <div className="w-full rounded-panel border border-rule bg-surface px-4 py-3">
            <p className="text-line font-medium text-ink">{request.title}</p>
            {request.quote ? (
              <ul className="mt-1.5 flex flex-col gap-1 border-t border-rule-subtle pt-1.5">
                {request.quote.split(" · ").map((part, i) => (
                  <li key={i} className="text-body text-ink-2 tabular">
                    {part}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          {approved ? (
            <Badge tone="paid" className="px-3 py-1 text-body">
              Approved by {approved}
            </Badge>
          ) : (
            <>
              <p className="text-body text-ink-2">{request.minRole && request.minRole !== "manager" ? `${/^[AEIOU]/.test(ROLE_LABEL[request.minRole] ?? "") ? "An" : "A"} ${ROLE_LABEL[request.minRole] ?? request.minRole} or above` : "A manager"} enters their PIN. You stay signed in.</p>
              <PinPad value={pin} onChange={setPin} onComplete={complete} error={error} isPending={pending} unlockHint={false} />
            </>
          )}
        </div>
      ) : null}
    </Sheet>
  );
}
