import type { OpenAPIHono } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { RoleSchema } from "@sail/shared";
import { config } from "../config.js";
import { withTransaction } from "../db/client.js";
import { staff } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import type { AppEnv } from "../lib/context.js";
import { dataResponse, defineOp, errorResponses, jsonBody, jsonResponse, z } from "../lib/openapi.js";
import { signDevBackOfficeToken } from "../auth/tokens.js";
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
        },
      },
      200,
    );
  });

  defineOp(
    app,
    {
      op: "auth.dev_token",
      method: "post",
      path: "/v1/auth/dev-token",
      tags: ["auth"],
      request: { body: jsonBody(z.object({ email: z.string().email() })) },
      responses: { 200: jsonResponse(z.object({ token: z.string(), staff_id: z.string() })), ...errorResponses },
    },
    async (c) => {
      const cfg = config();
      if (cfg.NODE_ENV === "production" || !cfg.DEV_AUTH_SECRET) throw new AppError("not_found", "Not available");
      const { email } = c.req.valid("json");
      const row = await withTransaction(async (t) => {
        const [s] = await t.db.select().from(staff).where(eq(staff.email, email)).limit(1);
        if (!s) throw AppError.notFound("staff with email", email);
        if (!s.authSubject) {
          const sub = `dev:${s.id}`;
          await t.db.update(staff).set({ authSubject: sub }).where(eq(staff.id, s.id));
          return { ...s, authSubject: sub };
        }
        return s;
      });
      const token = await signDevBackOfficeToken(row.authSubject!, email, 12 * 3600);
      return c.json({ token, staff_id: row.id }, 200);
    },
  );
}
