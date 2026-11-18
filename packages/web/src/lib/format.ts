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
  "adjustments.apply_manual": "Applied a discount or fee", "adjustments.remove": "Removed a discount or fee", "payments.record": "Took a payment",
  "payments.cancel": "Cancelled a terminal payment", "refunds.create": "Refunded", "overrides.grant": "Approved an override", "shifts.open": "Opened shift",
  "shifts.close": "Closed shift", "business_days.close": "Closed the business day", "imports.apply": "Imported a menu",
  "stock.set_daily_cap": "Set a daily cap",
  "categories.create": "Created a category", "categories.update": "Changed a category", "stations.unpair": "Unpaired a station",
  // Every other action the register audits, so none reads as its raw key (live-test final2 A P-A3).
  "tables.qr_sheet": "Printed the QR sheet", "tables.rotate_all_qr_tokens": "Rotated every table code", "availability.create": "Added an availability rule",
  "availability.update": "Changed an availability rule", "availability.delete": "Deleted an availability rule", "imports.create": "Uploaded a menu import",
  "customers.upsert": "Saved a customer", "customer_groups.set_members": "Changed a customer group", "customer_groups.create": "Added a customer group", "customer_groups.update": "Changed a customer group",
  "tax_classes.create": "Added a tax class", "tax_classes.update": "Changed a tax class", "tax_rates.delete": "Deleted tax rates",
  "layouts.create": "Added a POS layout", "layouts.update": "Changed a POS layout", "payment_providers.configure": "Set up card payments",
  "print_jobs.test": "Printed a test page", "relays.pairing_code": "Made a relay pairing code", "staff.login_linked": "Linked a sign-in",
  "agent_identities.create": "Added an assistant", "agent_identities.update": "Changed an assistant", "agent_identities.rotate_credential": "Renewed an assistant's key",
  "proposals.approve": "Approved a proposal", "proposals.reject": "Turned down a proposal", "rounds.accept": "Accepted a QR order", "rounds.reject": "Rejected a QR order",
  "printers.create": "Added a printer", "printers.update": "Changed a printer", "relays.create": "Added a print relay", "relays.update": "Changed a print relay",
  "areas.create": "Added an area", "areas.update": "Changed an area", "tables.create": "Added a table", "tables.update": "Changed a table",
  "tender_types.create": "Added a payment type", "tender_types.update": "Changed a payment type", "void_reasons.create": "Added a void reason", "void_reasons.update": "Changed a void reason",
  "channel_links.create": "Added a channel", "channel_links.update": "Changed a channel", "display_destinations.create": "Added a display route", "display_destinations.update": "Changed a display route",
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
const AUDIT_TARGET: Record<string, string> = { check: "Bill", payment_provider: "Card payments", tender_type: "Payment type", channel_link: "Channel", display_destination: "Display route", customer_group: "Customer group", layout: "POS layout", catalogue: "Catalogue", report_category: "Category", order_line: "Order line", import_job: "Menu import", availability_rule: "Availability rule", agent_identity: "Assistant", print_job: "Print job", business_day: "Business day" };
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
  "payment.voided": "Payment voided", "refund.created": "Refunded", "kitchen_ticket.created": "Shown on the kitchen display", "kitchen_ticket.bumped": "Bumped on the kitchen display", "round.submitted": "QR order sent",
  "round.accepted": "QR order accepted", "checks.split": "Bills split", "checks.allocated": "Items moved between bills", "check.split": "Bills split", "check.allocated": "Items moved between bills", "round.rejected": "QR order rejected", "adjustment.applied": "Discount applied", "adjustment.removed": "Discount removed", "print_job.created": "Print job created",
  // The product says bill, not check (review 4, T6).
  "check.paid": "Bill paid", "check.refunded": "Bill refunded",
};
export function eventLabel(type: string, payload?: unknown): string {
  // A line taken off before it was sent is removed, not voided: only a sent line is a void (L2).
  if (type === "line.voided" && payload && typeof payload === "object" && (payload as { after_firing?: unknown }).after_firing === false) return "Item removed";
  if (EVENT_LABEL[type]) return EVENT_LABEL[type]!;
  const [what = "", verb = ""] = type.split(".");
  const words = `${what.replace(/_/g, " ")} ${verb.replace(/_/g, " ")}`.trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : type;
}
