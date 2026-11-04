import { createRoute, OpenAPIHono, z, type RouteConfig, type RouteHandler } from "@hono/zod-openapi";
import type { Next } from "hono";
import { ApiErrorSchema, operation, roleAtLeast, type OperationSpec } from "@sail/shared";
import { AppError } from "./errors.js";
import type { AppEnv } from "./context.js";
import { principalRole } from "../auth/principal.js";

export { z };

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

function hasOverrideHeader(c: unknown): boolean {
  const ctx = c as { req?: { header(name: string): string | undefined } };
  return Boolean(ctx.req?.header("x-override-id"));
}
