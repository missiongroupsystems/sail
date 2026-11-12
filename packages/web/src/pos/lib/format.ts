import { formatBpsText, type LocaleFormat } from "@sail/ui";
import type { ManualRule, OrderStatus, OrderType } from "../api/types";

/** "0:42" (m:ss), "1:05:12" past an hour. Elapsed time on tables. */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

export const ORDER_TYPE_LABEL: Record<OrderType, string> = { dine_in: "Dine-in", takeaway: "Takeaway", pickup: "Pickup", delivery: "Delivery" };

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = { open: "New", fired: "Sent", ready: "Ready", out_for_delivery: "Out for delivery", completed: "Done", cancelled: "Cancelled" };

export const ROLE_LABEL: Record<string, string> = { server: "Server", cashier: "Cashier", manager: "Manager", finance: "Finance", admin: "Admin" };

/** "10%", "1–50%", "$0.01–$1,000.00": the rule's value or range, for the Discount list. */
export function describeRuleValue(rule: ManualRule, money: LocaleFormat["money"]): string {
  if (rule.value.type === "fixed") {
    if (rule.calc === "percent") return formatBpsText(rule.value.amount);
    return rule.value.amount === 0 ? "Waives" : money(rule.value.amount);
  }
  const { min, max } = rule.value;
  return rule.calc === "percent" ? `${formatBpsText(min)}–${formatBpsText(max)}` : `${money(min)}–${money(max)}`;
}

/** Initials for the user chip: "Mia Manager" → "MM". */
export function initialsOf(name: string | null | undefined): string {
  if (!name) return "··";
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/** A local time "HH:MM" today as an ISO string (ready-by entry). */
export function todayAt(hhmm: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() < Date.now() - 60_000) d.setDate(d.getDate() + 1);
  return d.toISOString();
}
