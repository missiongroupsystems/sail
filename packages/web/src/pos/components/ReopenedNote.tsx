"use client";

import { cx, useLocale } from "@sail/ui";
import type { CheckSnapshot } from "../api/types";

/**
 * The payments the last reopen reversed, as one quiet row above the order's lines (R B-N2), until a payment is taken
 * again. Only that reopen's: an earlier reopen's reversals are history, not news (review 5 W4). The amounts are the
 * register's payment rows; nothing is added up here.
 */
export function reopenedPayments(checks: CheckSnapshot[]) {
  const all = checks.flatMap((c) => c.payments);
  const reopened = all.filter((p) => p.status === "reversed" && p.reversal === "reopen" && p.reversed_at);
  // One reopen reverses its payments at one instant.
  const last = reopened.reduce<string | null>((m, p) => (m === null || p.reversed_at! > m ? p.reversed_at! : m), null);
  if (last === null || !checks.some((c) => c.balance > 0)) return [];
  if (all.some((p) => p.status === "recorded" && p.created_at > last)) return [];
  return reopened.filter((p) => p.reversed_at === last);
}

export function ReopenedNote({ checks, className }: { checks: CheckSnapshot[]; className?: string }) {
  const { money } = useLocale();
  const reversed = reopenedPayments(checks);
  if (reversed.length === 0) return null;
  const list = reversed.map((p) => `${money(p.amount)} by ${p.tender}`).join(", ");
  return (
    <p role="note" className={cx("px-3 py-2 text-caption text-ink-2", className)}>
      Reopened: {reversed.length === 1 ? `the payment of ${list} was` : `${reversed.length} payments (${list}) were`} reversed. Take payment again for the balance.
    </p>
  );
}
