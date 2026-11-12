import type { OpenAPIHono } from "@hono/zod-openapi";
import { RoleSchema } from "@sail/shared";
import type { AppEnv } from "../lib/context.js";
import { dataResponse, defineOp, errorResponses, jsonResponse, z } from "../lib/openapi.js";
import { outletScopeFor, principalRole } from "../auth/principal.js";

export const MeSchema = z.object({
  type: z.enum(["staff", "station", "guest", "relay", "agent"]),
  id: z.string(),
  merchant_id: z.string(),
  role: RoleSchema.nullable(),
  name: z.string().nullable(),
  outlet_scope: z.string(),
  outlet_id: z.string().nullable(),
  station_id: z.string().nullable(),
  via: z.string().nullable(),
  risk_ceiling: z.string().nullable(),
  agent: z.object({ identity_id: z.string(), session_id: z.string(), toolsets: z.array(z.string()), on_behalf_of: z.string().nullable() }).nullable(),
});

export function authRoutes(app: OpenAPIHono<AppEnv>) {
  defineOp(app, { op: "auth.me", method: "get", path: "/v1/me", tags: ["auth"], responses: { 200: jsonResponse(dataResponse(MeSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    return c.json(
      {
        data: {
          type: p.type,
          id: p.id,
          merchant_id: p.merchantId,
          role: principalRole(p),
          name: "name" in p ? p.name : null,
          outlet_scope: outletScopeFor(p),
          outlet_id: "outletId" in p ? (p.outletId ?? null) : null,
          station_id: "stationId" in p ? (p.stationId ?? null) : null,
          via: p.type === "staff" ? p.via : null,
          risk_ceiling: p.type === "staff" || p.type === "agent" ? p.riskCeiling : null,
          agent: p.type === "agent" ? { identity_id: p.identityId, session_id: p.sessionId, toolsets: p.toolsets, on_behalf_of: p.onBehalfOf } : null,
        },
      },
      200,
    );
  });
}
