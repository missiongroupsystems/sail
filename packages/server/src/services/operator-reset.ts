import type { Sql } from "postgres";
import { localSubject, normaliseEmail } from "../auth/identity.js";
import { randomToken, sha256 } from "../auth/tokens.js";

/** How long an operator's reset link works: the same 24 hours as an Admin's (routes/identity.ts). */
export const OPERATOR_RESET_HOURS = 24;

/**
 * A password reset link made by whoever runs the server, for a person who cannot get one from an Admin (the owner is
 * usually the only Admin). Same link as Team's "Password reset link": single use, 24 hours, earlier open links stop
 * working, and using it ends the person's other sessions. Recorded in the merchant's audit log as made by the operator.
 * Runs on the owner connection (scripts/reset-link.ts), so it sees every merchant; it never prints whether an email
 * exists anywhere but the operator's own terminal.
 */
export async function operatorResetLink(sql: Sql, emailIn: string, webAppUrl: string): Promise<{ url: string; expiresAt: Date; merchantId: string; staffId: string }> {
  const email = normaliseEmail(emailIn);
  const [row] = await sql<{ staff_id: string; merchant_id: string; active: boolean; auth_subject: string | null; name: string }[]>`
    select l.staff_id, s.merchant_id, s.active, s.auth_subject, s.name
    from backoffice_logins l join staff s on s.id = l.staff_id
    where l.email = ${email} limit 1`;
  if (!row) throw new Error(`No back-office login has the email ${email} on this server.`);
  if (!row.active) throw new Error(`${row.name} is inactive. An Admin makes them active first.`);
  if (row.auth_subject !== localSubject(row.staff_id)) throw new Error(`${row.name} has no back-office password yet: an Admin invites them instead.`);
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + OPERATOR_RESET_HOURS * 3600 * 1000);
  await sql.begin(async (tx) => {
    await tx`update backoffice_links set revoked_at = now() where staff_id = ${row.staff_id} and used_at is null and revoked_at is null`;
    await tx`insert into backoffice_links (merchant_id, staff_id, kind, token_hash, created_by, expires_at) values (${row.merchant_id}, ${row.staff_id}, 'reset', ${sha256(token)}, ${row.staff_id}, ${expiresAt})`;
    await tx`insert into audit_log (merchant_id, actor_type, actor_id, actor_name, action, target_kind, target_id, details) values (${row.merchant_id}, 'system', 'operator', 'Server operator', 'staff.reset_password', 'staff', ${row.staff_id}, ${tx.json({ by: "operator" })})`;
  });
  // The token travels in the fragment, which browsers never send to a server or put in a Referer header.
  return { url: `${webAppUrl.replace(/\/+$/, "")}/set-password#token=${token}`, expiresAt, merchantId: row.merchant_id, staffId: row.staff_id };
}
