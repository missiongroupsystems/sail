import type { OrderType } from "../domain.js";

/** Copy helpers shared by the templates (design doc section 6: sentence case, "7:42 pm" clock times). */

export const DEFAULT_TIME_ZONE = "Asia/Singapore";

export const ORDER_TYPE_LABELS: Record<OrderType, string> = {
  dine_in: "Dine-in",
  takeaway: "Takeaway",
  pickup: "Pickup",
  delivery: "Delivery",
};

/** ICU may insert narrow no-break spaces before "pm"; printers want plain spaces. */
function plainSpaces(s: string): string {
  return s.replace(/[  ]/g, " ");
}

function parse(iso: string): Date | undefined {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** "7:42 pm" */
export function formatTime(iso: string, timeZone = DEFAULT_TIME_ZONE): string {
  const d = parse(iso);
  if (!d) return iso;
  return plainSpaces(new Intl.DateTimeFormat("en-SG", { hour: "numeric", minute: "2-digit", hour12: true, timeZone }).format(d));
}

/** "4 Nov 2026" (a bare YYYY-MM-DD is formatted as that calendar date). */
export function formatDate(iso: string, timeZone = DEFAULT_TIME_ZONE): string {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const d = dateOnly ? new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))) : parse(iso);
  if (!d) return iso;
  const tz = dateOnly ? "UTC" : timeZone;
  return plainSpaces(new Intl.DateTimeFormat("en-SG", { day: "numeric", month: "short", year: "numeric", timeZone: tz }).format(d));
}

/** "4 Nov 2026, 7:42 pm" */
export function formatDateTime(iso: string, timeZone = DEFAULT_TIME_ZONE): string {
  const d = parse(iso);
  if (!d) return iso;
  return plainSpaces(
    new Intl.DateTimeFormat("en-SG", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone,
    }).format(d),
  );
}

/** "Table 12, 4 pax" for dine-in; "Ben 9123 4567" for customer orders; falls back to the order type. */
export function referenceLabel(h: {
  order_type: OrderType;
  table_name?: string;
  pax?: number;
  customer_ref?: { name?: string; mobile?: string };
}): string {
  if (h.order_type === "dine_in" || h.table_name) {
    const table = h.table_name ? `Table ${h.table_name}` : "";
    const pax = h.pax !== undefined ? `${h.pax} pax` : "";
    const parts = [table, pax].filter((p) => p.length > 0);
    if (parts.length > 0) return parts.join(", ");
  }
  const who = [h.customer_ref?.name, h.customer_ref?.mobile].filter((p): p is string => !!p && p.length > 0);
  if (who.length > 0) return who.join(" ");
  return ORDER_TYPE_LABELS[h.order_type];
}
