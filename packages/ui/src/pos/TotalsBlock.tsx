"use client";

import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import { cx } from "../lib/cx";
import { Icon } from "../components/Icon";
import { Money } from "../components/Money";

export type TotalsRow = {
  key: string;
  /** The register's name for the row: "Subtotal", "Service charge 10%", "Staff meal". */
  label: string;
  cents: number;
  kind: "subtotal" | "adjustment" | "tax" | "total";
  /** Secondary note, for example "frozen" or "approved by Aisha". */
  note?: string | null;
  /** A manual adjustment the signed-in user may take off again. */
  onRemove?: () => void;
  removeDisabled?: boolean;
};

export type TotalsBlockProps = {
  rows: TotalsRow[];
  /** The register has not replied within 150 ms: previous figures at 60% with a thin progress line (design 7.8). */
  pricing?: boolean;
  className?: string;
};

/**
 * The totals block (design 4.3): every adjustment by its rule name and with
 * the sign the register returned (discounts arrive negative and render with a
 * true minus sign). Rows whose amount changed flash once for 400 ms.
 */
export function TotalsBlock({ rows, pricing, className }: TotalsBlockProps) {
  const previous = useRef<Map<string, number> | null>(null);
  const [flashing, setFlashing] = useState<Set<string>>(new Set());

  useEffect(() => {
    const prev = previous.current;
    const next = new Map(rows.map((r) => [r.key, r.cents]));
    if (prev) {
      const changed = new Set<string>();
      for (const [k, v] of next) if (prev.has(k) ? prev.get(k) !== v : true) changed.add(k);
      if (changed.size) {
        setFlashing(changed);
        const t = setTimeout(() => setFlashing(new Set()), 450);
        previous.current = next;
        return () => clearTimeout(t);
      }
    }
    previous.current = next;
    return undefined;
  }, [rows]);

  return (
    <div className={cx("relative px-3 pt-2 pb-3", className)} aria-busy={pricing || undefined}>
      <div aria-hidden className={cx("absolute inset-x-3 top-0 h-px overflow-hidden", pricing ? "bg-rule" : "bg-transparent")}>
        {pricing ? <div className="pos-progress keep-motion h-full w-1/2 bg-ink" /> : null}
      </div>
      {/* Polite live region (design 10): a changed row is announced; the whole block is not re-read. */}
      <dl className={cx("transition-opacity duration-150", pricing && "opacity-60")} aria-live="polite" aria-atomic="false">
        {rows.map((r) => (
          <div
            key={r.key}
            className={cx(
              "flex items-center justify-between gap-3 rounded-sm px-1",
              r.kind === "total" ? "mt-1 pt-2 hairline-t" : "min-h-7",
              flashing.has(r.key) && "pos-flash keep-motion",
            )}
          >
            <dt className={cx("flex min-w-0 items-center gap-2", r.kind === "total" ? "text-title text-ink" : "text-body text-ink-2")}>
              <span className="truncate">{r.label}</span>
              {r.note ? <span className="truncate text-caption text-ink-2">{r.note}</span> : null}
              {r.onRemove ? (
                <AriaButton
                  onPress={r.onRemove}
                  isDisabled={r.removeDisabled}
                  aria-label={`Remove ${r.label}`}
                  className="press pos-touch flex size-7 items-center justify-center rounded-chip text-ink-2 outline-none data-[pressed]:bg-surface-2 data-[hovered]:bg-surface-2 data-[disabled]:opacity-40"
                >
                  <Icon icon={X} size={14} />
                </AriaButton>
              ) : null}
            </dt>
            <dd className="shrink-0">
              <Money cents={r.cents} size={r.kind === "total" ? "title" : "body"} className="text-ink" />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
