/* eslint-disable @typescript-eslint/no-explicit-any */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, asc, eq, isNull, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { registerOperations, type OperationSpec, type PrincipalKind, type Role } from "@sail/shared";
import { db } from "../db/client.js";
import { AppError } from "./errors.js";
import type { AppEnv } from "./context.js";
import { defineOp, errorResponses, jsonBody, jsonResponse, listResponse, mutationResponse, dataResponse, z } from "./openapi.js";
import { appendEvent } from "./events.js";
import { recordAudit } from "./audit.js";
import { outletVisible, type Principal } from "../auth/principal.js";

/**
 * A factory for simple reference entities (categories, tender types, void
 * reasons, areas, tables, customer groups...): list, get, create, update, with
 * events, audit, tenancy and optional outlet scoping. Anything with nested
 * structure gets hand-written routes instead.
 */
export type CrudConfig<TTable extends PgTable, TApi extends z.ZodTypeAny, TCreate extends z.ZodTypeAny, TPatch extends z.ZodTypeAny> = {
  /** Operation group, for example `tender_types` → ops `tender_types.list|get|create|update`. */
  group: string;
  path: string;
  tag: string;
  noun: string;
  table: TTable;
  columns: { id: PgColumn; merchantId: PgColumn; archivedAt?: PgColumn; outletId?: PgColumn; sort?: PgColumn; name?: PgColumn };
  api: TApi;
  create: TCreate;
  patch: TPatch;
  toApi: (row: TTable["$inferSelect"]) => z.infer<TApi>;
  fromCreate: (body: z.infer<TCreate>, principal: Principal) => TTable["$inferInsert"];
  fromPatch: (body: z.infer<TPatch>) => Partial<TTable["$inferInsert"]>;
  /** Roles: reads default to server, writes default to admin (config.edit). */
  roles?: { read?: Role | null; write?: Role };
  principals?: { read?: PrincipalKind[]; write?: PrincipalKind[] };
  aggregateKind: string;
  /** Extra list filters from the query string. */
  listQuery?: z.ZodObject<z.ZodRawShape>;
  listWhere?: (q: Record<string, unknown>) => SQL[];
  mcp?: { read: boolean };
};

export function defineCrud<TTable extends PgTable, TApi extends z.ZodTypeAny, TCreate extends z.ZodTypeAny, TPatch extends z.ZodTypeAny>(app: OpenAPIHono<AppEnv>, cfg: CrudConfig<TTable, TApi, TCreate, TPatch>) {
  const readRole = cfg.roles?.read === undefined ? "server" : cfg.roles.read;
  const writeRole = cfg.roles?.write ?? "admin";
  const readPrincipals = cfg.principals?.read ?? ["staff", "station", "agent"];
  const writePrincipals = cfg.principals?.write ?? ["staff", "agent"];
  const base = (op: string, summary: string, tier: OperationSpec["tier"], minRole: Role | null, principals: PrincipalKind[], emits: string[], expose: boolean): OperationSpec => ({
    op,
    summary,
    description: summary,
    tier,
    minRole,
    overrideAllowed: false,
    reasonRequired: false,
    dryRun: false,
    principals,
    emits,
    mcp: { expose, toolsets: expose ? ["pos.read", "config.author"] : [] },
  });
  const g = cfg.group;
  registerOperations({
    [`${g}.list`]: base(`${g}.list`, `List ${cfg.noun}s`, "T0", readRole, readPrincipals, [], cfg.mcp?.read ?? true),
    [`${g}.get`]: base(`${g}.get`, `Get a ${cfg.noun}`, "T0", readRole, readPrincipals, [], cfg.mcp?.read ?? true),
    [`${g}.create`]: base(`${g}.create`, `Create a ${cfg.noun}`, "T3", writeRole, writePrincipals, [`${cfg.aggregateKind}.created`], false),
    [`${g}.update`]: base(`${g}.update`, `Update a ${cfg.noun}`, "T3", writeRole, writePrincipals, [`${cfg.aggregateKind}.updated`], false),
  });

  const baseQuery = z.object({ include_archived: z.enum(["true", "false"]).optional(), outlet_id: z.uuid().optional() });
  const listQuery = cfg.listQuery ? baseQuery.extend(cfg.listQuery.shape) : baseQuery;
  const patchWithArchive = cfg.columns.archivedAt ? (cfg.patch as unknown as z.ZodObject<z.ZodRawShape>).extend({ archived: z.boolean().optional() }) : cfg.patch;

  defineOp(app, ({ op: `${g}.list`, method: "get", path: cfg.path, tags: [cfg.tag], request: { query: listQuery }, responses: { 200: jsonResponse(listResponse(cfg.api)), ...errorResponses } }) as never, (async (c: any) => {
    const p = c.get("principal");
    const q = c.req.valid("query") as Record<string, unknown> & { include_archived?: string; outlet_id?: string };
    const conds: SQL[] = [eq(cfg.columns.merchantId, p.merchantId)];
    if (cfg.columns.archivedAt && q.include_archived !== "true") conds.push(isNull(cfg.columns.archivedAt));
    if (cfg.columns.outletId && q.outlet_id) conds.push(eq(cfg.columns.outletId, q.outlet_id));
    if (cfg.listWhere) conds.push(...cfg.listWhere(q));
    const order = cfg.columns.sort ? [asc(cfg.columns.sort), ...(cfg.columns.name ? [asc(cfg.columns.name)] : [])] : cfg.columns.name ? [asc(cfg.columns.name)] : [];
    const rows = await db()
      .select()
      .from(cfg.table as PgTable)
      .where(and(...conds))
      .orderBy(...order);
    return c.json({ data: rows.map((r) => cfg.toApi(r as TTable["$inferSelect"])), next_cursor: null }, 200);
  }) as never);

  defineOp(app, ({ op: `${g}.get`, method: "get", path: `${cfg.path}/{id}`, tags: [cfg.tag], request: { params: z.object({ id: z.uuid() }) }, responses: { 200: jsonResponse(dataResponse(cfg.api)), ...errorResponses } }) as never, (async (c: any) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const [row] = await db()
      .select()
      .from(cfg.table as PgTable)
      .where(and(eq(cfg.columns.id, id), eq(cfg.columns.merchantId, p.merchantId)))
      .limit(1);
    if (!row) throw AppError.notFound(cfg.noun, id);
    return c.json({ data: cfg.toApi(row as TTable["$inferSelect"]) }, 200);
  }) as never);

  defineOp(app, ({ op: `${g}.create`, method: "post", path: cfg.path, tags: [cfg.tag], request: { body: jsonBody(cfg.create) }, responses: { 201: jsonResponse(mutationResponse(cfg.api)), ...errorResponses } }) as never, (async (c: any) => {
    const p = c.get("principal");
    const body = c.req.valid("json") as z.infer<TCreate>;
    const values = cfg.fromCreate(body, p) as Record<string, unknown>;
    const outletId = (values["outletId"] as string | undefined) ?? null;
    if (outletId && !(await outletVisible(p, outletId))) throw AppError.notFound("outlet", outletId);
    const [row] = await db()
      .insert(cfg.table as PgTable)
      .values({ ...values, merchantId: p.merchantId } as never)
      .returning();
    const apiRow = cfg.toApi(row as TTable["$inferSelect"]);
    const id = (row as { id: string }).id;
    const ev = await appendEvent({ merchantId: p.merchantId, outletId, type: `${cfg.aggregateKind}.created`, aggregate: { kind: cfg.aggregateKind, id }, operationId: `${g}.create`, payload: apiRow, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: `${g}.create`, targetKind: cfg.aggregateKind, targetId: id, outletId, details: { name: (apiRow as { name?: string }).name } });
    return c.json({ data: apiRow, events: [ev], warnings: [] }, 201);
  }) as never);

  defineOp(app, ({ op: `${g}.update`, method: "patch", path: `${cfg.path}/{id}`, tags: [cfg.tag], request: { params: z.object({ id: z.uuid() }), body: jsonBody(patchWithArchive as z.ZodTypeAny) }, responses: { 200: jsonResponse(mutationResponse(cfg.api)), ...errorResponses } }) as never, (async (c: any) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json") as z.infer<TPatch> & { archived?: boolean };
    const set = cfg.fromPatch(body) as Record<string, unknown>;
    if (cfg.columns.archivedAt && body.archived !== undefined) set["archivedAt"] = body.archived ? new Date() : null;
    if (Object.keys(set).length === 0) throw AppError.validation("Nothing to update");
    const [row] = await db()
      .update(cfg.table as PgTable)
      .set(set as never)
      .where(and(eq(cfg.columns.id, id), eq(cfg.columns.merchantId, p.merchantId)))
      .returning();
    if (!row) throw AppError.notFound(cfg.noun, id);
    const apiRow = cfg.toApi(row as TTable["$inferSelect"]);
    const outletId = ((row as Record<string, unknown>)["outletId"] as string | undefined) ?? null;
    const ev = await appendEvent({ merchantId: p.merchantId, outletId, type: `${cfg.aggregateKind}.updated`, aggregate: { kind: cfg.aggregateKind, id }, operationId: `${g}.update`, payload: body, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: `${g}.update`, targetKind: cfg.aggregateKind, targetId: id, outletId, details: body as Record<string, unknown> });
    return c.json({ data: apiRow, events: [ev], warnings: [] }, 200);
  }) as never);
}

/** Drop undefined keys so a PATCH only touches the fields it names. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}
