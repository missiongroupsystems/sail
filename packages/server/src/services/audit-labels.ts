import { and, eq, inArray } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { db } from "../db/client.js";
import { availabilityRules, brands, checks, customers, menuSections, menus, modifierGroups, orders, outlets, payments, pricingRules, printers, products, staff, stations, tables, taxClasses } from "../db/schema/index.js";

type AuditRow = { id: string; targetKind: string; targetId: string | null; action: string; details: Record<string, unknown> };

/** What an owner reads for one audit entry: its target in words, and how its entered value reads. */
export type AuditLabel = { target_label: string | null; value_kind: "percent" | "amount" | null };

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const isUuid = (v: string | null): v is string => !!v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Names by id from one table, scoped to the merchant. */
async function names(merchantId: string, table: PgTable & { id: PgColumn; merchantId: PgColumn }, nameCol: PgColumn, ids: string[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter(isUuid))];
  if (!want.length) return new Map();
  const rows = (await db()
    .select({ id: table.id, name: nameCol })
    .from(table as PgTable)
    .where(and(eq(table.merchantId, merchantId), inArray(table.id, want)))) as { id: string; name: string }[];
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * The words an owner would use for each entry's target (live-test final2 A P-A3): "P-0007 · Bill 1" for a bill, "P-0007"
 * for an order, a product's or a person's name, a pricing rule's name rather than its key. Read when the log is listed,
 * so entries written before this still read well. A target that no longer resolves has no label (the page then names
 * only its kind). Also says whether a manual discount's entered value is a percentage (basis points) or an amount.
 */
export async function auditLabels(merchantId: string, rows: AuditRow[]): Promise<Map<string, AuditLabel>> {
  const of = (kind: string) => rows.filter((r) => r.targetKind === kind).map((r) => r.targetId ?? "");
  const detailOrder = (r: AuditRow) => str(r.details.order_id);

  const checkRows = of("check").filter(isUuid);
  const paymentRows = of("payment").filter(isUuid);
  const billOf = checkRows.length ? await db().select({ id: checks.id, orderId: checks.orderId, label: checks.label }).from(checks).where(and(eq(checks.merchantId, merchantId), inArray(checks.id, checkRows))) : [];
  const payOf = paymentRows.length ? await db().select({ id: payments.id, orderId: payments.orderId }).from(payments).where(and(eq(payments.merchantId, merchantId), inArray(payments.id, paymentRows))) : [];
  // An availability rule reads as what it makes available: its product or menu section (the rule, or its entry once deleted).
  const ruleIds = of("availability_rule").filter(isUuid);
  const avail = new Map((ruleIds.length ? await db().select({ id: availabilityRules.id, kind: availabilityRules.targetKind, target: availabilityRules.targetId }).from(availabilityRules).where(and(eq(availabilityRules.merchantId, merchantId), inArray(availabilityRules.id, ruleIds))) : []).map((a) => [a.id, { kind: a.kind as string, target: a.target }]));
  const availTarget = (r: AuditRow) => avail.get(r.targetId ?? "") ?? (str(r.details.target_id) ? { kind: str(r.details.target_kind) ?? "product", target: str(r.details.target_id)! } : null);
  const availOf = (kind: string) => rows.filter((r) => r.targetKind === "availability_rule").map(availTarget).filter((t): t is { kind: string; target: string } => t?.kind === kind).map((t) => t.target);
  const sectionIds = availOf("section").filter(isUuid);
  const sectionName = new Map((sectionIds.length ? await db().select({ id: menuSections.id, name: menuSections.name }).from(menuSections).where(and(eq(menuSections.merchantId, merchantId), inArray(menuSections.id, sectionIds))) : []).map((x) => [x.id, x.name]));
  const orderIds = [...of("order"), ...rows.map(detailOrder).filter((x): x is string => !!x), ...billOf.map((b) => b.orderId), ...payOf.map((p) => p.orderId)];
  const [orderNo, product, menu, group, person, station, outlet, brand, table, taxClass, customer, printer] = await Promise.all([
    names(merchantId, orders, orders.orderNo, orderIds),
    names(merchantId, products, products.name, [...of("product"), ...availOf("product")]),
    names(merchantId, menus, menus.name, of("menu")),
    names(merchantId, modifierGroups, modifierGroups.name, of("modifier_group")),
    names(merchantId, staff, staff.name, of("staff")),
    names(merchantId, stations, stations.name, of("station")),
    names(merchantId, outlets, outlets.name, of("outlet")),
    names(merchantId, brands, brands.name, of("brand")),
    names(merchantId, tables, tables.name, of("table")),
    names(merchantId, taxClasses, taxClasses.name, of("tax_class")),
    names(merchantId, customers, customers.name, of("customer")),
    names(merchantId, printers, printers.name, of("printer")),
  ]);
  const ruleKeys = [...new Set([...of("pricing_rule"), ...rows.map((r) => str(r.details.rule_key)).filter((x): x is string => !!x)])];
  const ruleRows = ruleKeys.length ? await db().select({ key: pricingRules.ruleKey, version: pricingRules.version, body: pricingRules.body }).from(pricingRules).where(and(eq(pricingRules.merchantId, merchantId), inArray(pricingRules.ruleKey, ruleKeys))) : [];
  // The latest version of each rule names it.
  const rule = new Map<string, { name: string | null; calc: string | null }>();
  for (const r of [...ruleRows].sort((a, b) => a.version - b.version)) rule.set(r.key, { name: str(r.body.name), calc: str(r.body.calc) });
  const bill = new Map(billOf.map((b) => [b.id, b]));
  const pay = new Map(payOf.map((p) => [p.id, p]));

  const label = (r: AuditRow): string | null => {
    const id = r.targetId ?? "";
    switch (r.targetKind) {
      case "order":
        return orderNo.get(id) ?? str(r.details.order_no);
      case "check": {
        const b = bill.get(id);
        const no = b ? orderNo.get(b.orderId) : orderNo.get(detailOrder(r) ?? "");
        return no ? (b ? `${no} · ${b.label}` : no) : null;
      }
      case "payment": {
        const p = pay.get(id);
        return orderNo.get(p?.orderId ?? detailOrder(r) ?? "") ?? null;
      }
      case "order_line": {
        const no = orderNo.get(detailOrder(r) ?? "");
        const name = str(r.details.name);
        return no ? (name ? `${no} · ${name}` : no) : name;
      }
      case "pricing_rule":
        return rule.get(id)?.name ?? str(r.details.name);
      case "product":
        return product.get(id) ?? str(r.details.name);
      case "menu":
        return menu.get(id) ?? str(r.details.name);
      case "modifier_group":
        return group.get(id) ?? str(r.details.name);
      case "staff":
        return person.get(id) ?? str(r.details.name);
      case "station":
        return station.get(id) ?? str(r.details.name);
      case "outlet":
        return outlet.get(id) ?? str(r.details.name);
      case "brand":
        return brand.get(id) ?? str(r.details.name);
      case "table": {
        const name = table.get(id);
        return name ? `Table ${name}` : null;
      }
      case "tax_class":
        return taxClass.get(id) ?? str(r.details.name);
      case "customer":
        return customer.get(id) ?? str(r.details.name);
      case "printer":
        return printer.get(id) ?? str(r.details.name);
      case "availability_rule": {
        const t = availTarget(r);
        return t ? ((t.kind === "section" ? sectionName.get(t.target) : product.get(t.target)) ?? null) : null;
      }
      default:
        return str(r.details.name);
    }
  };
  const valueKind = (r: AuditRow): AuditLabel["value_kind"] => {
    if (typeof r.details.entered_value !== "number") return null;
    const calc = rule.get(str(r.details.rule_key) ?? "")?.calc;
    return calc === "percent" ? "percent" : calc ? "amount" : null;
  };
  return new Map(rows.map((r) => [r.id, { target_label: label(r), value_kind: valueKind(r) }]));
}
