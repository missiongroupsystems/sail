import type { LocaleFormat } from "@sail/ui";

/** "900 bps" -> "9%"; display only, never used for pricing. */
export function formatBps(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2)}%`;
}

/** Cash rounding increment in minor units -> "$0.05", "$1", or "Off", in the merchant's currency. Display only. */
export function formatRounding(increment: number | null, money: LocaleFormat["money"]): string {
  return increment ? money(increment, { dropZeroFraction: true }) : "Off";
}

/** Short id for tables: first 8 characters of a UUID. */
export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : "—";
}

/** Plain words for the register's audited actions ("orders.reopen" reads "Reopened order"); an unknown key is spelt out. */
const AUDIT_ACTION: Record<string, string> = {
  "auth.sign_in": "Signed in", "auth.sign_out": "Signed out", "auth.change_password": "Changed password", "payments.void": "Voided a payment", "payments.start": "Sent to the terminal",
  "lines.void_fired": "Voided a sent item", "lines.void": "Removed an unsent item", "lines.add_open_price": "Added an open-price item", "orders.move_table": "Moved table", "orders.change_type": "Changed order type",
  "documents.issue_invoice": "Issued an invoice", "print_jobs.reprint": "Reprinted", "print_jobs.reroute": "Rerouted a ticket", "relays.pair": "Paired a print relay", "auth.pin_sign_in": "Signed in with PIN",
  "merchants.update_settings": "Changed merchant settings", "brands.create": "Added brand", "brands.update": "Changed brand",
  "outlets.create": "Added outlet", "outlets.update": "Changed outlet", "stations.create": "Added station", "stations.update": "Changed station",
  "stations.pairing_code": "Made a pairing code", "stations.pair": "Paired a station", "staff.create": "Added staff", "staff.update": "Changed staff",
  "staff.invite": "Invited staff", "staff.reset_password": "Reset a password", "staff.revoke_access": "Revoked access",
  "products.create": "Added product", "products.update": "Changed product", "products.bulk_price": "Changed prices", "modifier_groups.create": "Added modifier group",
  "modifier_groups.update": "Changed modifier group", "menus.create": "Added menu", "menus.update": "Changed menu",
  "pricing_rules.create_version": "Saved a pricing rule", "pricing_rules.archive": "Archived a pricing rule", "tax_rates.set": "Set tax rates",
  "stock.mark_sold_out": "Marked sold out", "stock.restore": "Restored stock", "tables.rotate_qr_token": "Rotated a table code",
  "orders.open": "Opened order", "orders.cancel": "Cancelled order", "orders.reopen": "Reopened order", "orders.send": "Sent to the kitchen",
  "adjustments.apply_manual": "Applied a discount", "adjustments.remove": "Removed a discount", "payments.record": "Took a payment",
  "payments.cancel": "Voided a payment", "refunds.create": "Refunded", "overrides.grant": "Approved an override", "shifts.open": "Opened shift",
  "shifts.close": "Closed shift", "business_days.close": "Closed the business day", "imports.apply": "Imported a menu",
  "stock.set_daily_cap": "Set a daily cap",
  "categories.create": "Created a category", "categories.update": "Changed a category", "stations.unpair": "Unpaired a station",
};
/** "categories" → "category", "classes" → "class", "rules" → "rule" (E-N8: not "categorie"). */
function singular(word: string): string {
  if (/ies$/.test(word)) return word.replace(/ies$/, "y");
  if (/(ss|sh|ch|x)es$/.test(word)) return word.replace(/es$/, "");
  return word.replace(/s$/, "");
}
export function auditActionLabel(action: string): string {
  if (AUDIT_ACTION[action]) return AUDIT_ACTION[action]!;
  const [what = "", verb = ""] = action.split(".");
  const noun = what.split("_").map((w, i, all) => (i === all.length - 1 ? singular(w) : w)).join(" ");
  const words = `${verb.replace(/_/g, " ")} ${noun}`.trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : action;
}
/** Target kinds whose words differ from their name: a "report_category" is the menu's category. */
const AUDIT_TARGET: Record<string, string> = { report_category: "Category", order_line: "Order line", import_job: "Menu import", availability_rule: "Availability rule", agent_identity: "Assistant", print_job: "Print job", business_day: "Business day" };
/** "pricing_rule" reads "Pricing rule". */
export function auditTargetLabel(kind: string | null | undefined): string {
  if (!kind) return "—";
  if (AUDIT_TARGET[kind]) return AUDIT_TARGET[kind]!;
  const words = kind.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Event names in words (E-L11): "order.repriced" reads "Prices worked out again", "line.voided" reads "Line voided". */
const EVENT_LABEL: Record<string, string> = {
  "order.opened": "Order opened", "order.repriced": "Prices worked out again", "order.fired": "Sent to the kitchen", "order.completed": "Order completed", "order.cancelled": "Order cancelled",
  "order.reopened": "Order reopened", "order.moved": "Moved table", "line.added": "Item added", "line.updated": "Item changed", "line.voided": "Item voided", "payment.recorded": "Payment taken",
  "payment.voided": "Payment voided", "refund.created": "Refunded", "kitchen_ticket.created": "Kitchen ticket printed", "kitchen_ticket.bumped": "Kitchen ticket bumped", "round.submitted": "QR order sent",
  "round.accepted": "QR order accepted", "round.rejected": "QR order rejected", "adjustment.applied": "Discount applied", "adjustment.removed": "Discount removed", "print_job.created": "Print job created",
};
export function eventLabel(type: string, payload?: unknown): string {
  // A line taken off before it was sent is removed, not voided: only a sent line is a void (L2).
  if (type === "line.voided" && payload && typeof payload === "object" && (payload as { after_firing?: unknown }).after_firing === false) return "Item removed";
  if (EVENT_LABEL[type]) return EVENT_LABEL[type]!;
  const [what = "", verb = ""] = type.split(".");
  const words = `${what.replace(/_/g, " ")} ${verb.replace(/_/g, " ")}`.trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : type;
}
