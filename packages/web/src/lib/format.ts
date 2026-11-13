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
  "lines.void_fired": "Voided a sent item", "lines.add_open_price": "Added an open-price item", "orders.move_table": "Moved table", "orders.change_type": "Changed order type",
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
};
export function auditActionLabel(action: string): string {
  if (AUDIT_ACTION[action]) return AUDIT_ACTION[action]!;
  const [what = "", verb = ""] = action.split(".");
  const words = `${verb.replace(/_/g, " ")} ${what.replace(/_/g, " ").replace(/s$/, "")}`.trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : action;
}
/** "pricing_rule" reads "Pricing rule". */
export function auditTargetLabel(kind: string | null | undefined): string {
  if (!kind) return "—";
  const words = kind.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
