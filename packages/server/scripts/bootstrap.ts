/**
 * Create a merchant and its first Admin in a real environment:
 *   MIGRATE_DATABASE_URL=postgres://...:5432/... pnpm --filter @sail/server bootstrap "Merchant name" "Admin Name" admin@example.com [123456]
 */
import { bootstrapMerchant } from "../src/bootstrap.js";

const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
const [merchantName, adminName, email, pin] = process.argv.slice(2);
if (!url || !merchantName || !adminName || !email) {
  console.error('usage: MIGRATE_DATABASE_URL=... bootstrap "Merchant" "Admin Name" admin@example.com [pin]');
  process.exit(1);
}
const result = await bootstrapMerchant(url, { merchantName, admin: { name: adminName, email, pin } });
console.log(JSON.stringify(result, null, 2));
