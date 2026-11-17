/**
 * A password reset link for one back-office login, made by whoever runs the server: the way in for an owner who is the
 * business's only Admin and has forgotten the password (Sail sends no email).
 *   MIGRATE_DATABASE_URL=postgres://...:5432/... WEB_APP_URL=https://backoffice.example.com \
 *     pnpm --filter @sail/server reset-link owner@example.com
 * Prints the link once; it works for 24 hours, once, and ends the person's other sessions. docs/self-hosting.md.
 */
import postgres from "postgres";
import { operatorResetLink } from "../src/services/operator-reset.js";

const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
const web = process.env.WEB_APP_URL;
const [email] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!url || !web || !email) {
  console.error("usage: MIGRATE_DATABASE_URL=... WEB_APP_URL=https://backoffice.example.com reset-link person@example.com");
  process.exit(1);
}
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
try {
  const link = await operatorResetLink(sql, email, web);
  console.log(`Password reset link for ${email}, valid until ${link.expiresAt.toISOString()} and for one use:\n${link.url}`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
