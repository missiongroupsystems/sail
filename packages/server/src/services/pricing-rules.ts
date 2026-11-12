import { and, desc, eq, isNull, lte, sql } from "drizzle-orm";
import { PricingRuleSchema, type PricingRule, type PricingRuleInput } from "@sail/shared";
import { db, tx } from "../db/client.js";
import { pricingRules } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";

/**
 * The active rule set for a merchant at time `at`: for each rule_key, the newest
 * non-archived version whose effective_from <= at. Deterministic from the
 * table, so scheduled activation needs no worker to be correct; the worker only
 * flips `status` and emits events for the UI.
 */
export async function activeRules(merchantId: string, at: Date): Promise<PricingRule[]> {
  const rows = await tx()<{ body: Record<string, unknown>; version: number; rule_key: string }[]>`
    select distinct on (rule_key) rule_key, version, body
    from pricing_rules
    where merchant_id = ${merchantId} and archived_at is null and effective_from <= ${at.toISOString()}::timestamptz
    order by rule_key, effective_from desc, version desc`;
  return rows.map((r) => PricingRuleSchema.parse({ ...r.body, id: r.rule_key, version: r.version }));
}

/** The rule a manual adjustment came from: the active version, or the newest one once the rule is archived, so its roles still apply to removing it. */
export async function ruleOrLastVersion(merchantId: string, ruleKey: string, at: Date): Promise<PricingRule | null> {
  const active = (await activeRules(merchantId, at)).find((r) => r.id === ruleKey);
  if (active) return active;
  const [last] = await ruleVersions(merchantId, ruleKey);
  return last ? PricingRuleSchema.parse({ ...(last.body as Record<string, unknown>), id: last.ruleKey, version: last.version }) : null;
}

export async function ruleVersions(merchantId: string, ruleKey?: string) {
  const conds = [eq(pricingRules.merchantId, merchantId)];
  if (ruleKey) conds.push(eq(pricingRules.ruleKey, ruleKey));
  return db()
    .select()
    .from(pricingRules)
    .where(and(...conds))
    .orderBy(pricingRules.ruleKey, desc(pricingRules.version));
}

/** Create a new version of a rule (or the first version of a new rule). Returns the row. */
export async function createRuleVersion(merchantId: string, input: { rule_key: string; body: PricingRuleInput; effective_from: Date; note?: string | null; created_by?: string | null }) {
  const parsed = PricingRuleSchema.parse({ ...input.body, id: input.rule_key, version: 1 });
  const [latest] = await db()
    .select({ version: pricingRules.version })
    .from(pricingRules)
    .where(and(eq(pricingRules.merchantId, merchantId), eq(pricingRules.ruleKey, input.rule_key)))
    .orderBy(desc(pricingRules.version))
    .limit(1);
  const version = (latest?.version ?? 0) + 1;
  const body = { ...parsed, id: input.rule_key, version };
  const status = input.effective_from.getTime() <= Date.now() ? "active" : "scheduled";
  const [row] = await db()
    .insert(pricingRules)
    .values({ merchantId, ruleKey: input.rule_key, version, status, effectiveFrom: input.effective_from, body: body as unknown as Record<string, unknown>, note: input.note ?? null, createdBy: input.created_by ?? null })
    .returning();
  if (status === "active") {
    await db()
      .update(pricingRules)
      .set({ status: "superseded" })
      .where(and(eq(pricingRules.merchantId, merchantId), eq(pricingRules.ruleKey, input.rule_key), eq(pricingRules.status, "active"), sql`${pricingRules.version} < ${version}`));
  }
  return row!;
}

export async function archiveRule(merchantId: string, ruleKey: string) {
  const rows = await db()
    .update(pricingRules)
    .set({ archivedAt: new Date(), status: "archived" })
    .where(and(eq(pricingRules.merchantId, merchantId), eq(pricingRules.ruleKey, ruleKey), isNull(pricingRules.archivedAt)))
    .returning({ id: pricingRules.id });
  if (rows.length === 0) throw AppError.notFound("pricing rule", ruleKey);
  return rows.length;
}

/** Seed a merchant that has no rules yet with a preset's rules (`presetSeedRules`, scope doc 4.8). */
export async function seedRulesForMerchant(merchantId: string, rules: readonly PricingRuleInput[], effectiveFrom = new Date(0)) {
  const [existing] = await db().select({ n: sql<number>`count(*)::int` }).from(pricingRules).where(eq(pricingRules.merchantId, merchantId));
  if (existing && existing.n > 0) return 0;
  for (const rule of rules) {
    const parsed = PricingRuleSchema.parse(rule);
    await db().insert(pricingRules).values({ merchantId, ruleKey: parsed.id, version: 1, status: "active", effectiveFrom, body: { ...parsed, version: 1 } as unknown as Record<string, unknown>, note: "seed", createdBy: "system" });
  }
  return rules.length;
}

/** Worker task: flip scheduled versions whose time has come to active, superseding the previous active version. Returns the activated rows. */
export async function activateDueRules(at: Date) {
  const due = await tx()<{ id: string; merchant_id: string; rule_key: string; version: number }[]>`
    select id, merchant_id, rule_key, version from pricing_rules
    where status = 'scheduled' and archived_at is null and effective_from <= ${at.toISOString()}::timestamptz
    order by effective_from asc`;
  for (const r of due) {
    await tx()`update pricing_rules set status = 'superseded' where merchant_id = ${r.merchant_id} and rule_key = ${r.rule_key} and status = 'active' and version < ${r.version}`;
    await tx()`update pricing_rules set status = 'active' where id = ${r.id}`;
  }
  return due;
}

export { lte };
