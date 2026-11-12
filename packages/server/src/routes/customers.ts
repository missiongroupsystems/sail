import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, asc, eq, ilike, inArray, isNull, or, type SQL } from "drizzle-orm";
import { operation, PERMISSIONS, registerOperations, roleAtLeast } from "@sail/shared";
import { aboveCeiling } from "../services/agents.js";
import { principalRole } from "../auth/principal.js";
import { db } from "../db/client.js";
import { customerGroupMembers, customerGroups, customers } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import type { AppEnv } from "../lib/context.js";
import { dataResponse, defineOp, errorResponses, jsonBody, jsonResponse, listResponse, mutationResponse, z, untrusted } from "../lib/openapi.js";
import { appendEvent } from "../lib/events.js";
import { recordAudit } from "../lib/audit.js";
import { compact, defineCrud } from "../lib/crud.js";

registerOperations({
  "customers.find": { op: "customers.find", summary: "Find customers", description: "By mobile (exact or prefix) or name prefix. Not available to agents: they cannot read customer contact details.", tier: "T0", minRole: "server", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff"], emits: [], mcp: { expose: false, toolsets: [] } },
  "customers.get": { op: "customers.get", summary: "Get a customer with their groups", description: "Not available to agents: they cannot read customer contact details.", tier: "T0", minRole: "server", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff"], emits: [], mcp: { expose: false, toolsets: [] } },
  "customers.upsert": { op: "customers.upsert", summary: "Create or update a customer", description: "Mobile is unique per merchant. Consent changes are evented. Not available to agents.", tier: "T1", minRole: "cashier", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff"], emits: ["customer.upserted"], mcp: { expose: false, toolsets: [] } },
  "customer_groups.set_members": { op: "customer_groups.set_members", summary: "Add or remove customers from a group", description: "Changes pricing eligibility, so it is a configuration change and is evented.", tier: "T3", minRole: "manager", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff", "agent"], emits: ["customer_group.members_changed"], mcp: { expose: false, toolsets: [] } },
});

export const CustomerSchema = z.object({ id: z.string(), name: z.string(), mobile: z.string().nullable(), email: z.string().nullable(), marketing_consent: z.boolean(), notes: untrusted(z.string().nullable()), group_ids: z.array(z.string()), legacy_id: z.string().nullable(), archived: z.boolean() });
const CustomerUpsert = z.object({ id: z.uuid().optional(), name: untrusted(z.string().min(1), "name@customers"), mobile: untrusted(z.string().min(3).nullable().optional(), "mobile@customers"), email: z.string().email().nullable().optional(), marketing_consent: z.boolean().optional(), notes: untrusted(z.string().nullable().optional()), legacy_id: z.string().nullable().optional(), group_ids: z.array(z.uuid()).optional(), archived: z.boolean().optional() });

async function toCustomer(rows: (typeof customers.$inferSelect)[]) {
  const ids = rows.map((r) => r.id);
  const members = ids.length ? await db().select().from(customerGroupMembers).where(inArray(customerGroupMembers.customerId, ids)) : [];
  return rows.map((r) => ({ id: r.id, name: r.name, mobile: r.mobile, email: r.email, marketing_consent: r.marketingConsent, notes: r.notes, group_ids: members.filter((m) => m.customerId === r.id).map((m) => m.groupId), legacy_id: r.legacyId, archived: r.archivedAt != null }));
}

export function customerRoutes(app: OpenAPIHono<AppEnv>) {
  defineOp(app, { op: "customers.find", method: "get", path: "/v1/customers", tags: ["customers"], request: { query: z.object({ mobile: z.string().optional(), q: z.string().optional(), group_id: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) }, responses: { 200: jsonResponse(listResponse(CustomerSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const q = c.req.valid("query");
    const conds: SQL[] = [eq(customers.merchantId, p.merchantId), isNull(customers.archivedAt)];
    if (q.mobile) conds.push(ilike(customers.mobile, `${q.mobile.replace(/\s+/g, "")}%`));
    if (q.q) conds.push(or(ilike(customers.name, `${q.q}%`), ilike(customers.mobile, `${q.q}%`))!);
    if (q.group_id) {
      const ids = (await db().select({ id: customerGroupMembers.customerId }).from(customerGroupMembers).where(eq(customerGroupMembers.groupId, q.group_id))).map((x) => x.id);
      if (ids.length === 0) return c.json({ data: [], next_cursor: null }, 200);
      conds.push(inArray(customers.id, ids));
    }
    const rows = await db()
      .select()
      .from(customers)
      .where(and(...conds))
      .orderBy(asc(customers.name))
      .limit(q.limit);
    return c.json({ data: await toCustomer(rows), next_cursor: null }, 200);
  });

  defineOp(app, { op: "customers.get", method: "get", path: "/v1/customers/{id}", tags: ["customers"], request: { params: z.object({ id: z.uuid() }) }, responses: { 200: jsonResponse(dataResponse(CustomerSchema)), ...errorResponses } }, async (c) => {
    const { id } = c.req.valid("param");
    const [row] = await db().select().from(customers).where(eq(customers.id, id)).limit(1);
    if (!row) throw AppError.notFound("customer", id);
    return c.json({ data: (await toCustomer([row]))[0]! }, 200);
  });

  defineOp(app, { op: "customers.upsert", method: "put", path: "/v1/customers", tags: ["customers"], request: { body: jsonBody(CustomerUpsert) }, responses: { 200: jsonResponse(mutationResponse(CustomerSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const b = c.req.valid("json");
    // Group membership decides who gets a group's discounts: the same Manager step as customer_groups.set_members.
    const groupRole = PERMISSIONS["customer_groups.set_members"].minRole;
    const role = principalRole(p);
    if (b.group_ids && !(role && roleAtLeast(role, groupRole))) throw AppError.permission(groupRole, false, "customer_groups.set_members");
    // ... and the same risk tier: a person whose ceiling stops set_members cannot reach it through upsert.
    if (b.group_ids && aboveCeiling(p, operation("customer_groups.set_members"))) throw new AppError("permission_denied", "Changing a customer's groups is above your risk ceiling", { remedy: "Use customer_groups.set_members, which becomes a proposal for a Manager to approve." });
    const mobile = b.mobile ? b.mobile.replace(/\s+/g, "") : (b.mobile ?? null);
    let row: typeof customers.$inferSelect | undefined;
    if (b.id) {
      [row] = await db()
        .update(customers)
        .set({ ...compact({ name: b.name, mobile, email: b.email, marketingConsent: b.marketing_consent, notes: b.notes, legacyId: b.legacy_id, archivedAt: b.archived === undefined ? undefined : b.archived ? new Date() : null }), updatedAt: new Date() })
        .where(and(eq(customers.id, b.id), eq(customers.merchantId, p.merchantId)))
        .returning();
      if (!row) {
        [row] = await db().insert(customers).values({ id: b.id, merchantId: p.merchantId, name: b.name, mobile, email: b.email ?? null, marketingConsent: b.marketing_consent ?? false, notes: b.notes ?? null, legacyId: b.legacy_id ?? null }).returning();
      }
    } else if (mobile) {
      [row] = await db()
        .insert(customers)
        .values({ merchantId: p.merchantId, name: b.name, mobile, email: b.email ?? null, marketingConsent: b.marketing_consent ?? false, notes: b.notes ?? null, legacyId: b.legacy_id ?? null })
        .onConflictDoUpdate({ target: [customers.merchantId, customers.mobile], set: { name: b.name, ...compact({ email: b.email, marketingConsent: b.marketing_consent, notes: b.notes, legacyId: b.legacy_id }), updatedAt: new Date() } })
        .returning();
    } else {
      [row] = await db().insert(customers).values({ merchantId: p.merchantId, name: b.name, mobile: null, email: b.email ?? null, marketingConsent: b.marketing_consent ?? false, notes: b.notes ?? null, legacyId: b.legacy_id ?? null }).returning();
    }
    if (b.group_ids) {
      await db().delete(customerGroupMembers).where(eq(customerGroupMembers.customerId, row!.id));
      if (b.group_ids.length) await db().insert(customerGroupMembers).values(b.group_ids.map((groupId) => ({ merchantId: p.merchantId, groupId, customerId: row!.id })));
    }
    const data = (await toCustomer([row!]))[0]!;
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "customer.upserted", aggregate: { kind: "customer", id: row!.id }, operationId: "customers.upsert", payload: { name: data.name, consent: data.marketing_consent, group_ids: data.group_ids }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "customers.upsert", targetKind: "customer", targetId: row!.id, details: { consent: data.marketing_consent } });
    return c.json({ data: (await toCustomer([row!]))[0]!, events: [ev], warnings: [] }, 200);
  });

  const GroupSchema = z.object({ id: z.string(), name: z.string(), description: z.string().nullable(), archived: z.boolean() });
  defineCrud(app, {
    group: "customer_groups",
    path: "/v1/customer-groups",
    tag: "customers",
    noun: "customer group",
    table: customerGroups,
    columns: { id: customerGroups.id, merchantId: customerGroups.merchantId, archivedAt: customerGroups.archivedAt, name: customerGroups.name },
    api: GroupSchema,
    create: z.object({ id: z.uuid().optional(), name: z.string().min(1), description: z.string().nullable().optional() }),
    patch: z.object({ name: z.string().min(1).optional(), description: z.string().nullable().optional() }),
    roles: { write: "manager" },
    aggregateKind: "customer_group",
    toApi: (r) => ({ id: r.id, name: r.name, description: r.description, archived: r.archivedAt != null }),
    fromCreate: (b) => ({ id: b.id, merchantId: "", name: b.name, description: b.description ?? null }),
    fromPatch: (b) => compact({ name: b.name, description: b.description }),
  });

  defineOp(
    app,
    { op: "customer_groups.set_members", method: "post", path: "/v1/customer-groups/{id}/members", tags: ["customers"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(z.object({ add: z.array(z.uuid()).optional(), remove: z.array(z.uuid()).optional() })) }, responses: { 200: jsonResponse(mutationResponse(z.object({ group_id: z.string(), member_count: z.number().int() }))), ...errorResponses } },
    async (c) => {
      const p = c.get("principal");
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");
      const [g] = await db().select({ id: customerGroups.id }).from(customerGroups).where(eq(customerGroups.id, id)).limit(1);
      if (!g) throw AppError.notFound("customer group", id);
      if (b.remove?.length) await db().delete(customerGroupMembers).where(and(eq(customerGroupMembers.groupId, id), inArray(customerGroupMembers.customerId, b.remove)));
      if (b.add?.length) await db().insert(customerGroupMembers).values(b.add.map((customerId) => ({ merchantId: p.merchantId, groupId: id, customerId }))).onConflictDoNothing();
      const members = await db().select({ id: customerGroupMembers.customerId }).from(customerGroupMembers).where(eq(customerGroupMembers.groupId, id));
      const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "customer_group.members_changed", aggregate: { kind: "customer_group", id }, operationId: "customer_groups.set_members", payload: { add: b.add ?? [], remove: b.remove ?? [] }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
      await recordAudit(p, { action: "customer_groups.set_members", targetKind: "customer_group", targetId: id, details: { added: b.add?.length ?? 0, removed: b.remove?.length ?? 0 } });
      return c.json({ data: { group_id: id, member_count: members.length }, events: [ev], warnings: [] }, 200);
    },
  );
}
