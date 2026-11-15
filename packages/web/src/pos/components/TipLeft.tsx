"use client";

import { BillCard, type BillCardProps, useLocale } from "@sail/ui";
import type { CheckSnapshot } from "../api/types";
import { useTipLeft } from "../hooks/queries";

/** "Tip still to give back: $2.00", from the register's quote, for a bill refunded in full by items that still holds its tip. */
export function useTipLeftText(check: CheckSnapshot): string | null {
  const { money } = useLocale();
  const tip = useTipLeft(check).data;
  return tip ? `Tip still to give back: ${money(tip)}` : null;
}

/** A bill card whose status says when a tip is still to be given back. */
export function CheckBillCard({ check, ...props }: BillCardProps & { check: CheckSnapshot }) {
  const text = useTipLeftText(check);
  return <BillCard {...props} statusLabel={text} />;
}

/** The same words as a quiet note, for the closed order's bill rows. */
export function TipLeftNote({ check }: { check: CheckSnapshot }) {
  const text = useTipLeftText(check);
  return text ? <span className="text-status-sent"> · {text}</span> : null;
}
