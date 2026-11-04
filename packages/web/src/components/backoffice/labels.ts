/** Plain words for API enums (design 1.1). The API says `dine_in`; the UI says "Dine-in". */

export const ORDER_TYPE_LABEL: Record<string, string> = { dine_in: "Dine-in", takeaway: "Takeaway", pickup: "Pickup", delivery: "Delivery" };
export const ORDER_TYPES = ["dine_in", "takeaway", "pickup", "delivery"] as const;

export const CHANNEL_LABEL: Record<string, string> = { pos: "POS", scan_to_order: "Scan to order" };
export const CHANNELS = ["pos", "scan_to_order"] as const;

export const ORDER_STATUS_LABEL: Record<string, string> = {
  open: "Open",
  fired: "Sent to kitchen",
  ready: "Ready",
  out_for_delivery: "Out for delivery",
  completed: "Completed",
  cancelled: "Cancelled",
};
export const ORDER_STATUSES = ["open", "fired", "ready", "out_for_delivery", "completed", "cancelled"] as const;

export const LINE_STATUS_LABEL: Record<string, string> = { pending: "New", held: "Held", fired: "Sent", voided: "Voided" };

export const ROLE_LABEL: Record<string, string> = { server: "Server", cashier: "Cashier", manager: "Manager", finance: "Finance", admin: "Admin" };
export const ROLES = ["server", "cashier", "manager", "finance", "admin"] as const;

export const WEEKDAYS = [
  { id: 1, label: "Mon" },
  { id: 2, label: "Tue" },
  { id: 3, label: "Wed" },
  { id: 4, label: "Thu" },
  { id: 5, label: "Fri" },
  { id: 6, label: "Sat" },
  { id: 0, label: "Sun" },
] as const;

export const REPORT_CLASS_LABEL: Record<string, string> = {
  service_charge: "Service charge",
  deposit: "Deposit (BCRS)",
  delivery_fee: "Delivery fee",
  packaging_fee: "Packaging fee",
  promo: "Promotion",
  comp: "Complimentary",
  staff_meal: "Staff meal",
  ent: "Entertainment",
  other: "Other",
};
export const REPORT_CLASSES = ["service_charge", "deposit", "delivery_fee", "packaging_fee", "promo", "comp", "staff_meal", "ent", "other"] as const;

export const TILE_COLOURS = ["slate", "stone", "brass", "amber", "olive", "sage", "teal", "sky", "indigo", "plum", "rose", "brick"] as const;

export function label(map: Record<string, string>, key: string | null | undefined): string {
  if (!key) return "—";
  return map[key] ?? key.replace(/_/g, " ");
}

/** Today's date as YYYY-MM-DD in the merchant's zone (Asia/Singapore for the beta). */
export function todayBusinessDate(timeZone = "Asia/Singapore"): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Slug for a new rule key: "Service charge" -> "service_charge". */
export function slugKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}
