"use client";

import type { ReactNode } from "react";
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
  /** "Sold out" in place of the price (the tile stays in place so the layout never shifts). */
  soldOut?: boolean;
  /** Reason shown instead of "Sold out" when the item is unavailable for another reason. */
  unavailableReason?: string | null;
  /** Shown as "3 left" beside the price when 5 or fewer remain; in the alert colour when the order holds more than that. */
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

/** A tile's name: two lines at most, with the ellipsis at the end of the second when even that is not enough. */
const nameClass = "line-clamp-2 text-line leading-[1.25] font-medium [overflow-wrap:anywhere]";

/**
 * Names break between words ("Garden / salad", never "Garden sal-/ad" beside a count badge); only a name with a word
 * too long for a line of the tile is hyphenated, where the language allows (final review B-P15).
 */
export function tileHyphens(label: string): string {
  return label.split(/\s+/).some((w) => w.length >= 11) ? "hyphens-auto" : "hyphens-manual";
}

/**
 * Keeps the first line clear of the mark in the tile's top-right corner: an invisible copy of it (so it is exactly as
 * wide), floated right and only one line tall. It reaches 2px past the name's padding, as the mark does.
 */
function CornerSpacer({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span aria-hidden className={cx("invisible float-right -mr-0.5 ml-1.5 h-4 overflow-hidden tabular", className)}>
      {children}
    </span>
  );
}

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
      aria-label={[label, priceCents != null && !unavailable ? money(priceCents) : null, onOrder ? `${onOrder} on the order` : null, soldOut ? "sold out" : unavailableReason, lowStock ? `${capRemaining} left` : null, restrictedTo ? `needs ${restrictedTo} approval` : null]
        .filter(Boolean)
        .join(", ")}
    >
      <span className="flex min-h-0 flex-1 flex-col justify-between px-3 pt-3 pb-2.5">
        {/* The count badge has an invisible twin floated into the first line, so only the text beside it gives way: the
            second line keeps the tile's full width ("Cheeseburger deluxe" stays whole with a 12 badge). A word longer
            than the room beside the badge breaks, hyphenated where the language allows. */}
        <span className={cx(nameClass, tileHyphens(label), unavailable ? "text-ink-3" : "text-ink")}>
          <span className="block">
            {onOrder ? <CornerSpacer className="min-w-5 px-1.5 text-[12px] font-semibold">{onOrder}</CornerSpacer> : null}
            {label}
          </span>
        </span>
        {/* One state at a time in the foot: "Sold out" in place of the price, never drawn over it (final review B-P11);
            "5 left" beside the price, so the count badge stays in view (round 8, 3). */}
        <span className="flex items-end justify-between gap-2">
          {unavailable ? (
            <span className="text-caption font-medium text-status-alert">{soldOut ? "Sold out" : "Unavailable"}</span>
          ) : (
            <span className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: tileBand(colour) }} />
              {priceCents != null ? <span className="tabular text-[14px] text-ink-2">{money(priceCents)}</span> : null}
              {lowStock ? <span className={cx("truncate text-caption font-medium tabular", onOrder && onOrder > capRemaining! ? "text-status-alert" : "text-status-sent")}>· {capRemaining} left</span> : null}
            </span>
          )}
          {restrictedTo ? <span className="truncate rounded-chip bg-status-bill-tint px-2 text-caption font-medium text-status-bill">{restrictedTo} approval</span> : null}
        </span>
      </span>
      {onOrder ? <span aria-hidden className="absolute top-2 right-2.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-ink px-1.5 text-[12px] font-semibold text-surface tabular">{onOrder}</span> : null}
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
    <AriaButton onPress={onPress} className={cx(base, className)} aria-label={`${label}, folder${count != null ? ` with ${count} ${count === 1 ? "item" : "items"}` : ""}`}>
      <span className="flex min-h-0 flex-1 flex-col justify-between px-3 pt-3 pb-2.5">
        <span className={cx(nameClass, tileHyphens(label), "text-ink")}>
          <span className="block">
            <span aria-hidden className="float-right -mr-1 ml-1 h-4 w-[18px]" />
            {label}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: tileBand(colour) }} />
          <span className="text-[14px] text-ink-2 tabular">{count != null ? `${count} ${count === 1 ? "item" : "items"}` : "Open"}</span>
        </span>
      </span>
      <Icon icon={ChevronRight} size={18} className="absolute top-2.5 right-2 text-ink-3" />
    </AriaButton>
  );
}
