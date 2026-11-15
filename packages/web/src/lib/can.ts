"use client";

import { roleAtLeast, type Role } from "@sail/shared";
import { ROLE_LABEL } from "@/components/backoffice/labels";
import { OP_MIN_ROLE } from "./op-roles";
import { useSession } from "./session-context";

/**
 * Whether the signed-in role may run an operation, by the register's own manifest, and the reason when not ("Needs an
 * Admin."). Views leave out an action the role cannot use, or show it off with the reason, instead of letting someone fill
 * in a form the register then refuses.
 */
export function useCan(op: string): { ok: boolean; reason: string | null; who: string | null } {
  const { me } = useSession();
  const min = OP_MIN_ROLE[op] ?? null;
  if (!min || roleAtLeast(me.role as Role, min)) return { ok: true, reason: null, who: null };
  const label = ROLE_LABEL[min] ?? min;
  const who = `${/^[AEIOU]/.test(label) ? "an" : "a"} ${label}${min === "admin" ? "" : " or above"}`;
  return { ok: false, reason: `Changing this needs ${who}.`, who };
}
