"use client";

import { cx, useLocale } from "@sail/ui";
import type { CheckSnapshot } from "../api/types";

/**
 * A lasting line on a reopened order (R B-N2): the payments the reopen reversed, until the bill is paid again. The
 * amounts are the register's payment rows; nothing is added up here.
 */
export function ReopenedNote({ checks, className }: { checks: CheckSnapshot[]; className?: string }) {
  const { money } = useLocale();
  const reversed = checks.filter((c) => c.balance > 0).flatMap((c) => c.payments.filter((p) => p.status === "reversed" && p.reversal === "reopen"));
  if (reversed.length === 0) return null;
  const list = reversed.map((p) => `${money(p.amount)} by ${p.tender}`).join(", ");
  return (
    <p role="note" className={cx("rounded-tile bg-surface-2 px-3 py-2 text-caption text-ink", className)}>
      Reopened: {reversed.length === 1 ? `the payment of ${list} was` : `${reversed.length} payments (${list}) were`} reversed. Take payment again for the balance.
    </p>
  );
}
