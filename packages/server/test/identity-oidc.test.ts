import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp } from "../src/app.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

/**
 * The `oidc` identity provider, selected by configuring an external issuer: its JWTs keep working exactly as before
 * (subject to staff.auth_subject), and an Admin's pre-authorisation replaces the manual SQL that used to link a new
 * person. Unknown emails are never provisioned.
 */
const ISSUER_SECRET = "external-issuer-secret-for-tests-0123456789";
let db: TestDb;
let call: ReturnType<typeof api>["call"];
let A: SeededMerchant;
let adminToken: string;

const issue = (claims: Record<string, unknown>, sub: string) =>
  new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setSubject(sub).setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(ISSUER_SECRET));
const me = (token: string) => call<{ data: { id: string; via: string } }>("GET", "/v1/me", { token });

beforeAll(async () => {
  db = await freshDb({ SUPABASE_JWT_SECRET: ISSUER_SECRET });
  call = api(buildApp()).call;
  A = await seedMerchant(db.sql, "Alpha");
  await db.sql`update staff set auth_subject = 'issuer|admin-a' where id = ${A.admin.id}`;
  adminToken = await issue({ email: "whatever@issuer.test" }, "issuer|admin-a");
});
afterAll(async () => db.drop());

describe("oidc provider", () => {
  it("is selected by the issuer settings; password sign-in, links and local sessions are not used", async () => {
    expect((await call<{ data: { provider: string } }>("GET", "/v1/auth/status")).body.data.provider).toBe("oidc");
    expect((await call("POST", "/v1/auth/sign-in", { body: { email: "a@b.test", password: "x".repeat(12) }, idempotencyKey: null })).status).toBe(404);
    expect((await call("POST", "/v1/auth/links/accept", { body: { token: "t", password: "x".repeat(12) }, idempotencyKey: null })).status).toBe(404);
    // A session token minted for the local provider means nothing here.
    expect((await me(A.manager.token)).status).toBe(401);
  });

  it("an issuer token for a known subject signs in as before", async () => {
    const r = await me(adminToken);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ id: A.admin.id, via: "backoffice" });
  });

  it("an unknown subject with an unknown email is refused and nothing is created", async () => {
    const before = (await db.sql`select count(*)::int as n from staff`)[0]!.n;
    expect((await me(await issue({ email: "stranger@issuer.test" }, `issuer|${randomUUID()}`))).status).toBe(401);
    expect((await db.sql`select count(*)::int as n from staff`)[0]!.n).toBe(before);
  });

  it("an Admin pre-authorises a staff member's email; their first sign-in links the subject, once", async () => {
    const created = await call<{ data: { id: string } }>("POST", "/v1/staff", { token: adminToken, body: { name: "Joins Later", email: "Joins.Later@alpha.test", role: "manager", pin: "909090" } });
    const id = created.body.data.id;
    const invite = await call<{ data: { kind: string; email: string; url: string | null } }>("POST", `/v1/staff/${id}/invite`, { token: adminToken, body: {} });
    expect(invite.status, JSON.stringify(invite.body)).toBe(201);
    expect(invite.body.data).toEqual({ kind: "pre_authorised", email: "joins.later@alpha.test", url: null, expires_at: null });
    expect((await call<{ data: { status: string } }>("GET", `/v1/staff/${id}/access`, { token: adminToken })).body.data.status).toBe("invited");

    // Only a token that says the email is verified links: false, absent, or a claim the user can edit themselves
    // (user_metadata) does not, so an issuer that lets anyone claim any address cannot hand over an invited account.
    expect((await me(await issue({ email: "joins.later@alpha.test", email_verified: false }, "issuer|joins-later"))).status).toBe(401);
    expect((await me(await issue({ email: "joins.later@alpha.test" }, "issuer|joins-later"))).status).toBe(401);
    expect((await me(await issue({ email: "joins.later@alpha.test", email_verified: "true" }, "issuer|joins-later"))).status).toBe(401);
    expect((await me(await issue({ email: "joins.later@alpha.test", user_metadata: { email_verified: true } }, "issuer|joins-later"))).status).toBe(401);
    expect((await db.sql`select auth_subject from staff where id = ${id}`)[0]!.auth_subject).toBeNull();
    const first = await me(await issue({ email: "JOINS.LATER@alpha.test", email_verified: true }, "issuer|joins-later"));
    expect(first.status).toBe(200);
    expect(first.body.data.id).toBe(id);
    expect((await db.sql`select auth_subject from staff where id = ${id}`)[0]!.auth_subject).toBe("issuer|joins-later");
    expect((await me(await issue({}, "issuer|joins-later"))).status).toBe(200);
    // Someone else at the issuer with the same email cannot take the linked record.
    expect((await me(await issue({ email: "joins.later@alpha.test", email_verified: true }, "issuer|someone-else"))).status).toBe(401);
    expect((await call<{ data: { status: string } }>("GET", `/v1/staff/${id}/access`, { token: adminToken })).body.data.status).toBe("active");

    // Revoking unlinks the subject; the same issuer account is then refused.
    expect((await call("POST", `/v1/staff/${id}/revoke-access`, { token: adminToken, body: {} })).status).toBe(200);
    expect((await me(await issue({ email: "joins.later@alpha.test", email_verified: true }, "issuer|joins-later"))).status).toBe(401);
    // Resets are the issuer's job.
    expect((await call("POST", `/v1/staff/${id}/password-reset`, { token: adminToken, body: {} })).status).toBe(404);
  });
});
