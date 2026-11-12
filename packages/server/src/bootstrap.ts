import { randomUUID } from "node:crypto";
import postgres, { type TransactionSql } from "postgres";
import { isCurrencyCode, PricingRuleSchema, presetSeedRules, REGION_PRESETS, type RegionPreset, type RegionPresetKey, type TaxMode } from "@sail/shared";
import { hashSecret, pinLookup } from "./auth/tokens.js";
import { isCashRoundingIncrement, isValidLocale, isValidTimeZone } from "./lib/locale.js";

/**
 * Create a merchant with settings, one brand, one outlet, one station and an
 * Admin staff member, starting from a region preset (tax classes and rates,
 * service charge and deposit rules, tenders, cash denominations). There is no
 * self-serve onboarding in v0.9 (scope doc 5), so this is how a merchant is
 * created: by Engineering, once, per environment.
 */
export type BootstrapInput = {
  merchantName: string;
  brandName?: string;
  outletName?: string;
  admin: { name: string; email: string; pin?: string };
  preset: RegionPresetKey;
  /** IANA zone. Required: a preset only suggests one. */
  timeZone: string;
  /** Override the preset's; required for the blank preset. */
  currency?: string;
  locale?: string;
  taxMode?: TaxMode;
  cashRoundingIncrement?: number | null;
};

export type BootstrapResult = { merchantId: string; brandId: string; outletId: string; stationId: string; adminStaffId: string; taxClassIds: Record<string, string> };

export type MerchantSettingsInput = { timeZone: string; currency?: string; locale?: string; taxMode?: TaxMode; cashRoundingIncrement?: number | null };

/** The settings a preset and the caller's overrides produce, validated. Throws on anything missing or unknown, never defaults it. */
export function presetSettings(preset: RegionPreset, input: MerchantSettingsInput) {
  const currency = input.currency ?? preset.currency;
  const locale = input.locale ?? preset.locale;
  const cashRounding = input.cashRoundingIncrement === undefined ? preset.cash_rounding_increment : input.cashRoundingIncrement;
  if (!input.timeZone || !isValidTimeZone(input.timeZone)) throw new Error(`A merchant needs a valid IANA time zone (got ${JSON.stringify(input.timeZone)}); the ${preset.key} preset suggests ${preset.time_zone_suggestion ?? "none"}.`);
  if (!currency || !isCurrencyCode(currency)) throw new Error(`A merchant needs an ISO 4217 currency (got ${JSON.stringify(currency)}).`);
  if (!locale || !isValidLocale(locale)) throw new Error(`A merchant needs a BCP 47 locale (got ${JSON.stringify(locale)}).`);
  if (cashRounding != null && !isCashRoundingIncrement(cashRounding)) throw new Error(`Cash rounding ${cashRounding} is not 1, 2 or 5 times a power of ten minor units.`);
  return { timeZone: input.timeZone, currency, locale, taxMode: input.taxMode ?? preset.tax_mode, cashRounding };
}

/**
 * Write a merchant's settings, tax classes and rates from a preset. Returns
 * the created class ids by preset code, so fees can be wired to them.
 */
export async function applyPreset(tx: TransactionSql, merchantId: string, preset: RegionPreset, input: MerchantSettingsInput): Promise<Record<string, string>> {
  const s = presetSettings(preset, input);
  await tx`insert into merchant_settings (merchant_id, tax_mode, tax_rounding, cash_rounding_increment, cash_denominations, timezone, currency, locale, business_registration_label, tax_registration_label)
    values (${merchantId}, ${s.taxMode}, ${preset.tax_rounding}, ${s.cashRounding}, ${preset.cash_denominations}, ${s.timeZone}, ${s.currency}, ${s.locale}, ${preset.business_registration_label}, ${preset.tax_registration_label})`;
  const ids: Record<string, string> = {};
  for (const c of preset.tax_classes) {
    const id = randomUUID();
    ids[c.code] = id;
    await tx`insert into tax_classes (id, merchant_id, name, is_default) values (${id}, ${merchantId}, ${c.name}, ${c.code === preset.default_tax_class})`;
    await tx`insert into tax_rates (merchant_id, tax_class_id, components) values (${merchantId}, ${id}, ${tx.json(c.components)})`;
    for (const o of c.by_order_type ?? []) await tx`insert into tax_rates (merchant_id, tax_class_id, order_type, components) values (${merchantId}, ${id}, ${o.order_type}, ${tx.json(o.components)})`;
  }
  return ids;
}

/** The preset's seed pricing rules and tenders. */
export async function seedPresetRulesAndTenders(tx: TransactionSql, merchantId: string, preset: RegionPreset, taxClassIds: Record<string, string>) {
  for (const rule of presetSeedRules(preset, taxClassIds)) {
    const parsed = PricingRuleSchema.parse(rule);
    await tx`insert into pricing_rules (merchant_id, rule_key, version, status, effective_from, body, note, created_by) values (${merchantId}, ${parsed.id}, 1, 'active', ${new Date(0).toISOString()}, ${tx.json({ ...parsed, version: 1 })}, 'seed', 'system')`;
  }
  for (const [i, t] of preset.tenders.entries()) await tx`insert into tender_types (merchant_id, name, is_cash, opens_drawer, is_terminal, sort) values (${merchantId}, ${t.name}, ${t.is_cash}, ${t.is_cash}, ${t.is_terminal}, ${i})`;
}

export async function bootstrapMerchant(url: string, input: BootstrapInput): Promise<BootstrapResult> {
  const preset = REGION_PRESETS[input.preset];
  // Fail before touching the database when the settings are incomplete.
  presetSettings(preset, input);
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    return await sql.begin(async (tx) => {
      const merchantId = randomUUID();
      const brandId = randomUUID();
      const outletId = randomUUID();
      const stationId = randomUUID();
      const adminStaffId = randomUUID();
      await tx`insert into merchants (id, name) values (${merchantId}, ${input.merchantName})`;
      const taxClassIds = await applyPreset(tx, merchantId, preset, input);
      await seedPresetRulesAndTenders(tx, merchantId, preset, taxClassIds);
      await tx`insert into brands (id, merchant_id, name, accent_color) values (${brandId}, ${merchantId}, ${input.brandName ?? input.merchantName}, '#B26B00')`;
      await tx`insert into outlets (id, merchant_id, name, hours) values (${outletId}, ${merchantId}, ${input.outletName ?? "Main outlet"}, ${tx.json({ mon: [["11:00", "22:00"]], tue: [["11:00", "22:00"]], wed: [["11:00", "22:00"]], thu: [["11:00", "22:00"]], fri: [["11:00", "23:00"]], sat: [["11:00", "23:00"]], sun: [["11:00", "22:00"]] })})`;
      await tx`insert into stations (id, merchant_id, outlet_id, brand_id, name, seats_enabled) values (${stationId}, ${merchantId}, ${outletId}, ${brandId}, 'Station 1', true)`;
      await tx`insert into staff (id, merchant_id, name, initials, email, role, pin_hash, pin_lookup) values (${adminStaffId}, ${merchantId}, ${input.admin.name}, ${initials(input.admin.name)}, ${input.admin.email}, 'admin', ${input.admin.pin ? hashSecret(input.admin.pin) : null}, ${input.admin.pin ? pinLookup(merchantId, input.admin.pin) : null})`;
      await tx`insert into audit_log (merchant_id, actor_type, actor_id, actor_name, action, target_kind, target_id, details) values (${merchantId}, 'system', 'bootstrap', 'bootstrap', 'merchant.bootstrap', 'merchant', ${merchantId}, ${tx.json({ admin_email: input.admin.email, preset: preset.key })})`;
      return { merchantId, brandId, outletId, stationId, adminStaffId, taxClassIds };
    }) as unknown as Promise<BootstrapResult>;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}
