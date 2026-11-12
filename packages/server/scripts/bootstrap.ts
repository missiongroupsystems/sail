/**
 * Create a merchant and its first Admin in a real environment, from a region preset (the headless version of the
 * back office's first-run setup):
 *   MIGRATE_DATABASE_URL=postgres://...:5432/... SAIL_ADMIN_PASSWORD='at least 12 characters' \
 *     pnpm --filter @sail/server bootstrap "Merchant name" "Admin Name" admin@example.com [123456] \
 *     --preset=eu-vat --time-zone=Europe/Berlin [--currency=EUR] [--locale=de-DE]
 * Presets: sg, us, eu-vat, jp, blank (blank needs --currency and --locale).
 * The optional 6 digits are the Admin's POS PIN. With SAIL_ADMIN_PASSWORD the Admin signs in to the back office with
 * that email and password (the local identity provider); without it, the email is pre-authorised for the external
 * identity provider and linked on the Admin's first sign-in there. The password is read from the environment so it
 * stays out of the shell history and the process list.
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
  console.error('usage: MIGRATE_DATABASE_URL=... [SAIL_ADMIN_PASSWORD=...] bootstrap "Merchant" "Admin Name" admin@example.com [pin] --preset=sg|us|eu-vat|jp|blank --time-zone=<IANA zone> [--currency=XXX] [--locale=xx-XX]');
  process.exit(1);
}
const password = process.env.SAIL_ADMIN_PASSWORD || undefined;
const result = await bootstrapMerchant(url, { merchantName, admin: { name: adminName, email, pin, password }, preset: preset.data, timeZone, currency: flag("currency"), locale: flag("locale") });
console.log(JSON.stringify(result, null, 2));
