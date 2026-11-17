import { localParts, zonedToUtc } from "@sail/shared";
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

/** "4 items": units, as the guest's phone counts them (final review C Low: the POS once counted lines). */
export function countItems(lines: readonly { quantity: number }[]): string {
  const n = lines.reduce((sum, l) => sum + l.quantity, 0);
  return `${n} ${n === 1 ? "item" : "items"}`;
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

/** An example ready-by time in the clock the app shows: "7:30 pm" on a 12-hour clock, "19:30" on a 24-hour one. */
export function readyByExample(clock: (d: Date) => string): string {
  return /[ap]\.?\s?m/i.test(clock(new Date())) ? "7:30 pm" : "19:30";
}

/** A time ("19:30" or "7:30 pm") today in the outlet's zone (not the iPad's) as an ISO string, tomorrow once it has passed (ready-by entry). */
export function todayAt(hhmm: string, timeZone: string, now = new Date()): string | null {
  // "19:30", or the 12-hour clock the app shows: "7:30 pm", "7:30pm", "7 pm" (review 3, S8).
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(?:([ap])\.?\s*m\.?)?$/i.exec(hhmm.trim());
  if (!m || (!m[2] && !m[3])) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? "0");
  if (m[3]) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (m[3].toLowerCase() === "p" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const today = localParts(now, timeZone).date;
  const at = zonedToUtc(today, time, timeZone);
  if (at.getTime() >= now.getTime() - 60_000) return at.toISOString();
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return zonedToUtc(tomorrow, time, timeZone).toISOString();
}
