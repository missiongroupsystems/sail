"use client";

import { ChevronRight } from "lucide-react";
import { Button as AriaButton } from "react-aria-components";
import { cx } from "../lib/cx";
import { Icon } from "../components/Icon";
import { useLocale } from "../lib/locale";
import { tileBand } from "./tileColours";

export type TileProps = {
  label: string;
  /** Register price for the current order type, in cents. Omitted on folders. */
  priceCents?: number | null;
  colour: string;
  onPress: () => void;
  /** "Sold out" overlay (the tile stays in place so the layout never shifts). */
  soldOut?: boolean;
  /** Reason shown instead of "Sold out" when the item is unavailable for another reason. */
  unavailableReason?: string | null;
  /** Shown as "3 left" when 5 or fewer remain. */
  capRemaining?: number | null;
  /** The access level the tile needs that the signed-in role lacks: "Cashier", "Manager", "Admin". */
  restrictedTo?: string | null;
  isDisabled?: boolean;
  /** How many of this item are on the order already: a black count badge in the corner. */
  onOrder?: number;
  className?: string;
};

const base =
  "press pos-touch relative flex h-24 w-full max-w-[136px] shrink-0 flex-col overflow-hidden rounded-tile border border-rule bg-surface text-left outline-none " +
  "transition-[background-color,border-color,transform] duration-[120ms] " +
  "data-[hovered]:border-rule-strong data-[pressed]:scale-[0.97] data-[pressed]:bg-surface-2 " +
  "data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus";

/**
 * A catalogue tile: up to 136 × 96 (it fills a narrower grid cell) on the white sheet, the tile's colour as a small dot
 * beside the price (never a stripe along an edge), the name in medium, the price in tabular figures, and a count badge
 * when the item is on the order.
 */
export function Tile({ label, priceCents, colour, onPress, soldOut, unavailableReason, capRemaining, restrictedTo, isDisabled, onOrder, className }: TileProps) {
  const { money } = useLocale();
  const unavailable = soldOut || Boolean(unavailableReason);
  const lowStock = !unavailable && capRemaining != null && capRemaining <= 5;
  return (
    <AriaButton
      onPress={onPress}
      isDisabled={isDisabled}
      className={cx(base, className)}
      aria-label={[label, priceCents != null ? money(priceCents) : null, onOrder ? `${onOrder} on the order` : null, soldOut ? "sold out" : unavailableReason, lowStock ? `${capRemaining} left` : null, restrictedTo ? `needs ${restrictedTo} approval` : null]
        .filter(Boolean)
        .join(", ")}
    >
      <span className="flex min-h-0 flex-1 flex-col justify-between px-3 pt-3 pb-2.5">
        <span className={cx("line-clamp-2 text-line leading-[1.25] font-medium text-ink", lowStock ? "pr-14" : onOrder ? "pr-8" : null)}>{label}</span>
        <span className="flex items-end justify-between gap-2">
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: tileBand(colour) }} />
            {priceCents != null ? <span className="tabular text-[14px] text-ink-2">{money(priceCents)}</span> : null}
          </span>
          {restrictedTo ? <span className="truncate rounded-chip bg-status-bill-tint px-2 text-caption font-medium text-status-bill">{restrictedTo} approval</span> : null}
        </span>
      </span>
      {lowStock ? <span className="absolute top-3 right-2.5 text-caption font-medium text-status-sent tabular">{capRemaining} left</span> : onOrder ? <span aria-hidden className="absolute top-2.5 right-2.5 flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-ink px-1.5 text-[12px] font-semibold text-surface tabular">{onOrder}</span> : null}
      {unavailable ? (
        <span className="absolute inset-0 flex items-end bg-[color-mix(in_oklab,var(--bg)_78%,transparent)] px-3 pb-2.5">
          <span className="text-caption font-medium text-status-alert">{soldOut ? "Sold out" : "Unavailable"}</span>
        </span>
      ) : null}
    </AriaButton>
  );
}

export type FolderTileProps = {
  label: string;
  colour: string;
  count?: number;
  onPress: () => void;
  className?: string;
};

/** A folder tile: the same footprint with a ▸ corner. */
export function FolderTile({ label, colour, count, onPress, className }: FolderTileProps) {
  return (
    <AriaButton onPress={onPress} className={cx(base, className)} aria-label={`${label}, folder${count != null ? ` with ${count} items` : ""}`}>
      <span className="flex min-h-0 flex-1 flex-col justify-between px-3 pt-3 pb-2.5">
        <span className="line-clamp-2 pr-5 text-line leading-[1.25] font-medium text-ink">{label}</span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: tileBand(colour) }} />
          <span className="text-[14px] text-ink-2 tabular">{count != null ? `${count} items` : "Open"}</span>
        </span>
      </span>
      <Icon icon={ChevronRight} size={18} className="absolute top-3.5 right-2 text-ink-3" />
    </AriaButton>
  );
}
