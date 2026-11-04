import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { hashSecret, pinLookup } from "./auth/tokens.js";

/**
 * Create a merchant with settings, one brand, one outlet, one station and an
 * Admin staff member. There is no self-serve onboarding in v0.9 (scope doc 5),
 * so this is how a merchant is created: by Engineering, once, per environment.
 */
export type BootstrapInput = {
  merchantName: string;
  brandName?: string;
  outletName?: string;
  admin: { name: string; email: string; pin?: string };
  taxMode?: "inclusive" | "exclusive";
  cashRoundingIncrement?: number | null;
};

export type BootstrapResult = { merchantId: string; brandId: string; outletId: string; stationId: string; adminStaffId: string };

export async function bootstrapMerchant(url: string, input: BootstrapInput): Promise<BootstrapResult> {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    return await sql.begin(async (tx) => {
      const merchantId = randomUUID();
      const brandId = randomUUID();
      const outletId = randomUUID();
      const stationId = randomUUID();
      const adminStaffId = randomUUID();
      await tx`insert into merchants (id, name) values (${merchantId}, ${input.merchantName})`;
      await tx`insert into merchant_settings (merchant_id, tax_mode, cash_rounding_increment) values (${merchantId}, ${input.taxMode ?? "exclusive"}, ${input.cashRoundingIncrement ?? null})`;
      await tx`insert into brands (id, merchant_id, name, accent_color) values (${brandId}, ${merchantId}, ${input.brandName ?? input.merchantName}, '#B26B00')`;
      await tx`insert into outlets (id, merchant_id, name, hours) values (${outletId}, ${merchantId}, ${input.outletName ?? "Main outlet"}, ${tx.json({ mon: [["11:00", "22:00"]], tue: [["11:00", "22:00"]], wed: [["11:00", "22:00"]], thu: [["11:00", "22:00"]], fri: [["11:00", "23:00"]], sat: [["11:00", "23:00"]], sun: [["11:00", "22:00"]] })})`;
      await tx`insert into stations (id, merchant_id, outlet_id, brand_id, name, seats_enabled) values (${stationId}, ${merchantId}, ${outletId}, ${brandId}, 'Station 1', true)`;
      await tx`insert into staff (id, merchant_id, name, initials, email, role, pin_hash, pin_lookup) values (${adminStaffId}, ${merchantId}, ${input.admin.name}, ${initials(input.admin.name)}, ${input.admin.email}, 'admin', ${input.admin.pin ? hashSecret(input.admin.pin) : null}, ${input.admin.pin ? pinLookup(merchantId, input.admin.pin) : null})`;
      await tx`insert into audit_log (merchant_id, actor_type, actor_id, actor_name, action, target_kind, target_id, details) values (${merchantId}, 'system', 'bootstrap', 'bootstrap', 'merchant.bootstrap', 'merchant', ${merchantId}, ${tx.json({ admin_email: input.admin.email })})`;
      return { merchantId, brandId, outletId, stationId, adminStaffId };
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
