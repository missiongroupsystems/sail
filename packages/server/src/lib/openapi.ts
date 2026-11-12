import { createRoute, OpenAPIHono, z, type RouteConfig, type RouteHandler } from "@hono/zod-openapi";
import type { Next } from "hono";
import { ApiErrorSchema, operation, roleAtLeast, type OperationSpec } from "@sail/shared";
import { AppError } from "./errors.js";
import { markDryRun } from "../db/client.js";
import { aboveCeiling, createProposal, directCeiling, toProposal } from "../services/agents.js";
import type { AppEnv } from "./context.js";
import { principalRole } from "../auth/principal.js";

export { z };

/**
 * Marks a field as free text from outside the register: typed by a guest or customer, or by a person during service.
 * The MCP adapter wraps it as `{ untrusted_text }` wherever its key comes back in a response. `returnedAs` names the
 * keys it comes back under when they differ, and `key@group` limits it to the responses of one operation group (a
 * customer's `name`, where `name` elsewhere is a product's). An unmarked free-text request field fails the MCP test.
 */
export function untrusted<T extends z.ZodType>(schema: T, ...returnedAs: string[]): T {
  return schema.openapi({ "x-sail-untrusted": returnedAs.length ? returnedAs : true }) as T;
}

/** Shared response envelopes. */
export const EventRefSchema = z.object({
  id: z.string(),
  seq: z.number().int(),
  type: z.string(),
  occurredAt: z.string(),
  businessDate: z.string(),
});

export function dataResponse<T extends z.ZodTypeAny>(schema: T) {
  return z.object({ data: schema });
}
export function listResponse<T extends z.ZodTypeAny>(schema: T) {
  return z.object({ data: z.array(schema), next_cursor: z.string().nullable() });
}
export function mutationResponse<T extends z.ZodTypeAny>(schema: T) {
  return z.object({ data: schema, events: z.array(EventRefSchema), warnings: z.array(z.string()) });
}

export const errorResponses = {
  400: { description: "Validation error", content: { "application/json": { schema: ApiErrorSchema } } },
  401: { description: "Unauthenticated", content: { "application/json": { schema: ApiErrorSchema } } },
  403: { description: "Permission denied", content: { "application/json": { schema: ApiErrorSchema } } },
  404: { description: "Not found", content: { "application/json": { schema: ApiErrorSchema } } },
  409: { description: "Conflict (state, version or idempotency)", content: { "application/json": { schema: ApiErrorSchema } } },
  422: { description: "Invariant violation or unavailable", content: { "application/json": { schema: ApiErrorSchema } } },
} as const;

export function jsonBody<T extends z.ZodTypeAny>(schema: T, description = "Request body") {
  return { content: { "application/json": { schema } }, description, required: true };
}
export function jsonResponse<T extends z.ZodTypeAny>(schema: T, description = "OK") {
  return { description, content: { "application/json": { schema } } };
}

export type OpRoute = Omit<RouteConfig, "operationId"> & { op: string };

export function createApp() {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) {
        const issues = result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message, code: i.code }));
        throw new AppError("validation", issues[0] ? `${issues[0].path || "body"}: ${issues[0].message}` : "Invalid request", { remedy: "Fix the listed fields and retry.", details: { issues } });
      }
    },
  });
}

/**
 * Define one operation: the route gets its `operationId` and `x-sail` manifest
 * entry from the shared manifest, and the handler is wrapped with the manifest's
 * principal and role checks. Every /v1 route goes through here, so no route
 * checks roles by hand.
 */
/** The typed context a handler receives for a route (validated params, query and body). */
export type OpContext<R extends OpRoute> = Parameters<RouteHandler<R & { operationId: string }, AppEnv>>[0];

export function defineOp<R extends OpRoute>(app: OpenAPIHono<AppEnv>, route: R, handler: (c: OpContext<R>, next: Next) => Promise<Response> | Response) {
  const { op, ...rest } = route;
  const spec = operation(op);
  const full = createRoute({
    ...(rest as RouteConfig),
    operationId: op,
    description: rest.description ?? spec.description,
    summary: rest.summary ?? spec.summary,
    "x-sail": manifestExtension(spec),
  } as unknown as R & { operationId: string });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.openapi(full, (async (c: any, next: any) => {
    c.set("operationId", op);
    enforce(c, spec);
    const principal = c.get("principal") as AppEnv["Variables"]["principal"] | undefined;
    const method = String(c.req.method).toUpperCase();
    // Reads, quotes and dry runs are T0 by nature; anything else above the caller's ceiling becomes a proposal.
    if (principal && method !== "GET" && spec.principals.length > 0 && aboveCeiling(principal, spec)) {
      if (spec.proposable === false) throw new AppError("permission_denied", `${spec.op} is above this caller's risk ceiling and cannot be proposed`, { remedy: "Ask someone without a risk ceiling to do it.", details: { action: spec.op, tier: spec.tier } });
      let body: unknown = null;
      try {
        body = await c.req.json();
      } catch {
        body = null;
      }
      if (spec.dryRun && (body as { dry_run?: unknown } | null)?.dry_run === true) {
        // A dry run commits nothing, so it is T0 by nature: mark the transaction here, so it rolls back even if the handler forgets to.
        markDryRun();
        c.set("dryRun", true);
        return handler(c, next);
      }
      const proposal = await createProposal({ principal, spec, method, path: c.req.path + (c.req.url.includes("?") ? c.req.url.slice(c.req.url.indexOf("?")) : ""), body, idempotencyKey: c.get("idempotencyKey") ?? null, rationale: c.req.header("x-rationale") ?? null, correlationId: c.get("correlationId") });
      const ceiling = principal.type === "agent" || principal.type === "staff" ? directCeiling(principal.type, principal.riskCeiling) : null;
      return c.json(
        {
          code: "requires_confirmation",
          message: `${spec.op} is a ${spec.tier} operation, above this ${principal.type === "agent" ? "agent" : "person"}'s ${ceiling} ceiling; a proposal was created for a human to approve`,
          remedy: `Ask a ${spec.minRole ?? "staff member"} or above to approve proposal ${proposal.id} on the POS or in the back office. Poll proposals.get for the outcome; propose again from the fresh state if it fails.`,
          details: { proposal_id: proposal.id, tier: spec.tier, ceiling, expires_at: proposal.expiresAt.toISOString() },
          data: toProposal(proposal),
        },
        202,
      );
    }
    return handler(c, next);
  }) as never);
  return full;
}

export function manifestExtension(spec: OperationSpec) {
  return {
    op: spec.op,
    tier: spec.tier,
    min_role: spec.minRole,
    override_allowed: spec.overrideAllowed,
    reason_required: spec.reasonRequired,
    dry_run: spec.dryRun,
    principals: spec.principals,
    emits: spec.emits,
    mcp: spec.mcp,
  };
}

function enforce(c: { get(k: "principal"): AppEnv["Variables"]["principal"] | undefined }, spec: OperationSpec) {
  if (spec.principals.length === 0) return; // public route (health, dev token, pairing)
  const principal = c.get("principal");
  if (!principal) throw new AppError("unauthenticated", "Missing bearer token");
  if (!spec.principals.includes(principal.type)) {
    throw new AppError("permission_denied", `${spec.op} is not available to ${principal.type} principals`, {
      remedy: principal.type === "station" ? "Sign in with a PIN first." : "Use a staff or station token.",
      details: { action: spec.op, principal_type: principal.type },
    });
  }
  if (spec.minRole) {
    const role = principalRole(principal);
    if (!role) throw new AppError("permission_denied", `${spec.op} needs a signed-in staff member`, { remedy: "Sign in with a PIN first.", details: { action: spec.op, required_role: spec.minRole } });
    if (!roleAtLeast(role, spec.minRole)) {
      // Manager override grants are checked by the handler (v0.4) when override_allowed; here the base role check fails.
      if (!spec.overrideAllowed || !hasOverrideHeader(c)) throw AppError.permission(spec.minRole, spec.overrideAllowed, spec.op);
    }
  }
}

/** An override grant may arrive as the `X-Override-Id` header or as `override_id` in the JSON body; the handler verifies it. */
function hasOverrideHeader(c: unknown): boolean {
  const ctx = c as { req?: { header(name: string): string | undefined; valid?(target: "json"): unknown } };
  if (ctx.req?.header("x-override-id")) return true;
  try {
    const body = ctx.req?.valid?.("json") as { override_id?: unknown } | undefined;
    return typeof body?.override_id === "string" && body.override_id.length > 0;
  } catch {
    return false;
  }
}
