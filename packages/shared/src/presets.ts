import { z } from "zod";
import type { OrderType, TaxMode, TaxRounding } from "./domain.js";
import { seedRules } from "./pricing/seed.js";
import type { PricingRuleInput, TaxComponent } from "./pricing/schemas.js";

/**
 * Region presets: the starting configuration a merchant is created with. A
 * preset is data only; nothing in the engine or the server branches on which
 * one was picked. Every value it sets stays editable afterwards. Amounts are
 * in the currency's minor units.
 */
export type PresetTaxClass = {
  /** Stable key inside the preset, used to wire fees and the default class to the created rows. */
  code: string;
  name: string;
  components: TaxComponent[];
  /** Rates that replace `components` for one order type (Japan's 8% takeaway). */
  by_order_type?: { order_type: OrderType; components: TaxComponent[] }[];
};

export type RegionPreset = {
  key: RegionPresetKey;
  name: string;
  /** Null: the merchant must choose (the blank preset). */
  currency: string | null;
  locale: string | null;
  /** Shown as the suggestion when a merchant is created; the time zone itself is always given explicitly. */
  time_zone_suggestion: string | null;
  tax_mode: TaxMode;
  tax_rounding: TaxRounding;
  tax_classes: PresetTaxClass[];
  /** Code of the class products use when they name none. */
  default_tax_class: string;
  service_charge: { name: string; bps: number; order_types: OrderType[]; tax_class: string | null } | null;
  deposit: { name: string; amount: number; tax_class: string | null } | null;
  amount_off_bill_max: number;
  item_discount_cap: number;
  /** Cash tenders round to this many minor units; null is off. */
  cash_rounding_increment: number | null;
  tenders: { name: string; is_cash: boolean; is_terminal: boolean }[];
  /** Notes and coins for the cash counter, largest first, in minor units. */
  cash_denominations: number[];
  /** Closing a shift more than this many minor units out needs a reason. Null: five units of the currency chosen (the blank preset). */
  cash_variance_threshold: number | null;
  /** The POS pay screen offers a tip: on where tipping is customary, off elsewhere (a merchant can change it). */
  tips_enabled: boolean;
  business_registration_label: string;
  tax_registration_label: string;
};

export const REGION_PRESET_KEYS = ["sg", "us", "eu-vat", "jp", "blank"] as const;
export type RegionPresetKey = (typeof REGION_PRESET_KEYS)[number];
export const RegionPresetKeySchema = z.enum(REGION_PRESET_KEYS);
export const isRegionPresetKey = (k: string): k is RegionPresetKey => (REGION_PRESET_KEYS as readonly string[]).includes(k);
/**
 * A preset key in an API request: checked against the presets when parsed, but published as a plain string, so adding
 * a preset changes no API contract (openapi.json, the generated client types) and needs no regeneration.
 */
export const RegionPresetKeyInput = z.string().min(1).max(40).refine(isRegionPresetKey, { message: "Unknown region preset" });

const CASH_AND_CARD = [
  { name: "Cash", is_cash: true, is_terminal: false },
  { name: "Card", is_cash: false, is_terminal: true },
];

export const REGION_PRESETS: Record<RegionPresetKey, RegionPreset> = {
  /** Singapore: GST 9% on exclusive prices rounded per line, 10% dine-in service charge, container deposit. */
  sg: {
    key: "sg",
    name: "Singapore (GST)",
    currency: "SGD",
    locale: "en-SG",
    time_zone_suggestion: "Asia/Singapore",
    tax_mode: "exclusive",
    tax_rounding: "per_line",
    tax_classes: [{ code: "standard", name: "Standard-rated", components: [{ name: "GST 9%", bps: 900 }] }],
    default_tax_class: "standard",
    service_charge: { name: "Service charge 10%", bps: 1000, order_types: ["dine_in"], tax_class: "standard" },
    deposit: { name: "Container deposit", amount: 10, tax_class: null },
    amount_off_bill_max: 100_000,
    item_discount_cap: 5000,
    cash_rounding_increment: null,
    tenders: [...CASH_AND_CARD, { name: "PayNow", is_cash: false, is_terminal: true }],
    cash_denominations: [10_000, 5000, 1000, 500, 200, 100, 50, 20, 10, 5],
    cash_variance_threshold: 500,
    tips_enabled: false,
    business_registration_label: "UEN",
    tax_registration_label: "GST Reg No",
  },
  /** United States: exclusive sales tax with a state and a local component, rounded once per rate; grocery items exempt. */
  us: {
    key: "us",
    name: "United States (sales tax)",
    currency: "USD",
    locale: "en-US",
    time_zone_suggestion: "America/New_York",
    tax_mode: "exclusive",
    tax_rounding: "per_rate",
    tax_classes: [
      { code: "prepared_food", name: "Prepared food", components: [{ name: "State sales tax", bps: 400 }, { name: "Local sales tax", bps: 450 }] },
      { code: "exempt", name: "Exempt (grocery)", components: [] },
    ],
    default_tax_class: "prepared_food",
    service_charge: null,
    deposit: null,
    amount_off_bill_max: 100_000,
    item_discount_cap: 5000,
    cash_rounding_increment: null,
    tenders: CASH_AND_CARD,
    cash_denominations: [10_000, 5000, 2000, 1000, 500, 100, 25, 10, 5, 1],
    cash_variance_threshold: 500,
    tips_enabled: true,
    business_registration_label: "EIN",
    tax_registration_label: "Sales tax permit",
  },
  /** European Union, generic: inclusive VAT with a standard and a reduced rate, rounded once per rate. */
  "eu-vat": {
    key: "eu-vat",
    name: "European Union (VAT)",
    currency: "EUR",
    locale: "en-IE",
    time_zone_suggestion: "Europe/Dublin",
    tax_mode: "inclusive",
    tax_rounding: "per_rate",
    tax_classes: [
      { code: "standard", name: "Standard rate", components: [{ name: "VAT 20%", bps: 2000 }] },
      { code: "reduced", name: "Reduced rate", components: [{ name: "VAT 10%", bps: 1000 }] },
      { code: "exempt", name: "Exempt", components: [] },
    ],
    default_tax_class: "standard",
    service_charge: null,
    deposit: null,
    amount_off_bill_max: 100_000,
    item_discount_cap: 5000,
    cash_rounding_increment: null,
    tenders: CASH_AND_CARD,
    cash_denominations: [20_000, 10_000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1],
    cash_variance_threshold: 500,
    tips_enabled: false,
    business_registration_label: "Company reg. no.",
    tax_registration_label: "VAT no.",
  },
  /** Japan: inclusive consumption tax, 10% dine-in and 8% reduced for takeaway food, rounded once per rate (qualified invoices). */
  jp: {
    key: "jp",
    name: "Japan (consumption tax)",
    currency: "JPY",
    locale: "ja-JP",
    time_zone_suggestion: "Asia/Tokyo",
    tax_mode: "inclusive",
    tax_rounding: "per_rate",
    tax_classes: [
      {
        code: "food",
        name: "Food and soft drinks",
        components: [{ name: "Consumption tax 10%", bps: 1000 }],
        by_order_type: (["takeaway", "pickup", "delivery"] as const).map((order_type) => ({ order_type, components: [{ name: "Consumption tax 8% (reduced)", bps: 800 }] })),
      },
      { code: "alcohol", name: "Alcohol", components: [{ name: "Consumption tax 10%", bps: 1000 }] },
    ],
    default_tax_class: "food",
    service_charge: null,
    deposit: null,
    amount_off_bill_max: 100_000,
    item_discount_cap: 5000,
    cash_rounding_increment: null,
    tenders: CASH_AND_CARD,
    cash_denominations: [10_000, 5000, 1000, 500, 100, 50, 10, 5, 1],
    cash_variance_threshold: 1000,
    tips_enabled: false,
    business_registration_label: "Corporate number",
    tax_registration_label: "Registration number",
  },
  /** Nothing configured: one untaxed class, cash only. Currency and locale must be given. */
  blank: {
    key: "blank",
    name: "Blank",
    currency: null,
    locale: null,
    time_zone_suggestion: null,
    tax_mode: "exclusive",
    tax_rounding: "per_rate",
    tax_classes: [{ code: "standard", name: "Standard", components: [] }],
    default_tax_class: "standard",
    service_charge: null,
    deposit: null,
    amount_off_bill_max: 100_000,
    item_discount_cap: 5000,
    cash_rounding_increment: null,
    tenders: [{ name: "Cash", is_cash: true, is_terminal: false }],
    cash_denominations: [],
    cash_variance_threshold: null,
    tips_enabled: false,
    business_registration_label: "Business reg. no.",
    tax_registration_label: "Tax reg. no.",
  },
};

/** The preset's seed rules, with its tax class codes replaced by the ids the caller created for them. */
export function presetSeedRules(preset: RegionPreset, taxClassIds: Record<string, string>): PricingRuleInput[] {
  const id = (code: string | null) => {
    if (code == null) return null;
    const v = taxClassIds[code];
    if (!v) throw new RangeError(`preset ${preset.key}: no id for tax class ${code}`);
    return v;
  };
  return seedRules({
    service_charge: preset.service_charge && { name: preset.service_charge.name, bps: preset.service_charge.bps, order_types: preset.service_charge.order_types, tax_class_id: id(preset.service_charge.tax_class) },
    deposit: preset.deposit && { name: preset.deposit.name, amount: preset.deposit.amount, tax_class_id: id(preset.deposit.tax_class) },
    amount_off_bill_max: preset.amount_off_bill_max,
    item_discount_cap: preset.item_discount_cap,
  });
}

