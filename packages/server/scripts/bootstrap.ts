/**
 * Create a merchant and its first Admin in a real environment, from a region preset:
 *   MIGRATE_DATABASE_URL=postgres://...:5432/... pnpm --filter @sail/server bootstrap "Merchant name" "Admin Name" admin@example.com [123456] \
 *     --preset=eu-vat --time-zone=Europe/Berlin [--currency=EUR] [--locale=de-DE]
 * Presets: sg, us, eu-vat, jp, blank (blank needs --currency and --locale).
 */
import { RegionPresetKeySchema } from "@sail/shared";
import { bootstrapMerchant } from "../src/bootstrap.js";

const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const [merchantName, adminName, email, pin] = args.filter((a) => !a.startsWith("--"));
const preset = RegionPresetKeySchema.safeParse(flag("preset"));
const timeZone = flag("time-zone");
if (!url || !merchantName || !adminName || !email || !preset.success || !timeZone) {
  console.error('usage: MIGRATE_DATABASE_URL=... bootstrap "Merchant" "Admin Name" admin@example.com [pin] --preset=sg|us|eu-vat|jp|blank --time-zone=<IANA zone> [--currency=XXX] [--locale=xx-XX]');
  process.exit(1);
}
const result = await bootstrapMerchant(url, { merchantName, admin: { name: adminName, email, pin }, preset: preset.data, timeZone, currency: flag("currency"), locale: flag("locale") });
console.log(JSON.stringify(result, null, 2));
