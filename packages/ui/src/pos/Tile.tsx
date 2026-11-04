"use client";

import { ChevronRight } from "lucide-react";
import { Button as AriaButton } from "react-aria-components";
import { cx } from "../lib/cx";
import { Icon } from "../components/Icon";
import { formatCents } from "../components/Money";
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
  className?: string;
};

const base =
  "press pos-touch relative flex h-24 w-[136px] shrink-0 flex-col overflow-hidden rounded-tile bg-surface-2 text-left outline-none " +
  "data-[pressed]:scale-[0.97] data-[pressed]:brightness-90 data-[hovered]:brightness-[1.03] " +
  "data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-status-seated";

/** A catalogue tile (design 4.3): 136 × 96, a 6pt colour band, name at 17pt, price in tabular figures. */
export function Tile({ label, priceCents, colour, onPress, soldOut, unavailableReason, capRemaining, restrictedTo, isDisabled, className }: TileProps) {
  const unavailable = soldOut || Boolean(unavailableReason);
  const lowStock = !unavailable && capRemaining != null && capRemaining <= 5;
  return (
    <AriaButton
      onPress={onPress}
      isDisabled={isDisabled}
      className={cx(base, className)}
      aria-label={[label, priceCents != null ? formatCents(priceCents) : null, soldOut ? "sold out" : unavailableReason, lowStock ? `${capRemaining} left` : null, restrictedTo ? `needs ${restrictedTo} approval` : null]
        .filter(Boolean)
        .join(", ")}
    >
      <span aria-hidden className="block h-1.5 w-full shrink-0" style={{ backgroundColor: tileBand(colour) }} />
      <span className="flex min-h-0 flex-1 flex-col justify-between px-3 pt-2 pb-2">
        <span className="line-clamp-2 text-line leading-[22px] text-ink">{label}</span>
        <span className="flex items-end justify-between gap-2">
          {restrictedTo ? <span className="truncate rounded-chip bg-[color-mix(in_srgb,var(--status-bill)_14%,transparent)] px-2 text-caption text-status-bill">{restrictedTo} approval</span> : <span />}
          {priceCents != null ? <span className="tabular text-caption text-ink-2">{formatCents(priceCents)}</span> : null}
        </span>
      </span>
      {lowStock ? <span className="absolute top-3 right-2 rounded-chip bg-[color-mix(in_srgb,var(--status-sent)_18%,transparent)] px-2 text-caption text-status-sent tabular">{capRemaining} left</span> : null}
      {unavailable ? (
        <span className="absolute inset-0 flex items-end bg-[color-mix(in_srgb,var(--surface)_72%,transparent)] px-3 pb-2">
          <span className="rounded-chip bg-ink px-2 text-caption text-surface">{soldOut ? "Sold out" : "Unavailable"}</span>
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

/** A folder tile: the same footprint with a ▸ corner (design 4.3). */
export function FolderTile({ label, colour, count, onPress, className }: FolderTileProps) {
  return (
    <AriaButton onPress={onPress} className={cx(base, className)} aria-label={`${label}, folder${count != null ? ` with ${count} items` : ""}`}>
      <span aria-hidden className="block h-1.5 w-full shrink-0" style={{ backgroundColor: tileBand(colour) }} />
      <span className="flex min-h-0 flex-1 flex-col justify-between px-3 pt-2 pb-2">
        <span className="line-clamp-2 text-line leading-[22px] text-ink">{label}</span>
        <span className="text-caption text-ink-2 tabular">{count != null ? `${count} items` : "Open"}</span>
      </span>
      <Icon icon={ChevronRight} size={18} className="absolute top-3 right-2 text-ink-2" />
    </AriaButton>
  );
}
