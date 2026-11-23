import type { MiddlewareHandler } from "hono";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { maybeTx, TxDeadlineError, withRequestTransaction, withTransaction, type RequestTx } from "../db/client.js";
import { AppError } from "../lib/errors.js";
import { AdmissionGate } from "../lib/gate.js";
import type { AppEnv } from "../lib/context.js";
import { brandScopeFor, dbRoleFor, outletScopeFor, principalRole, type Principal } from "../auth/principal.js";
import { resolvePrincipal } from "../auth/resolve.js";
import { RLS_OPT_OUT, SHORT_TX_ROUTES } from "../db/rls-opt-out.js";
import { proposalOrderPin } from "../services/agents.js";
import { logger } from "../logger.js";

let gate: AdmissionGate | null = null;
export function admissionGate(): AdmissionGate {
  if (!gate) {
    const cfg = config();
    gate = new AdmissionGate(cfg.TX_MAX, cfg.QUEUE_MAX, cfg.QUEUE_WAIT_MS);
  }
  return gate;
}
export function resetGateForTests() {
  gate = null;
}

/** Requests a client makes on its own (polling, streams) rather than because a person did something. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

class RollbackSignal extends Error {
  constructor(readonly response: Response) {
    super("rollback");
  }
}

/**
 * The request pipeline: admission gate → one
 * transaction per request → principal resolution → set_config('app.current_*')
 * → SET LOCAL ROLE → handler. A 4xx/5xx response rolls the transaction back.
 */
export const requestPipeline: MiddlewareHandler<AppEnv> = async (c, next) => {
  const requestId = c.req.header("x-request-id") ?? randomUUID();
  c.set("requestId", requestId);
  c.set("correlationId", c.req.header("x-correlation-id") ?? requestId);
  c.header("x-request-id", requestId);

  const path = c.req.path;
  if (RLS_OPT_OUT.some((p) => p.test(path))) return next();

  const bearer = readBearer(c.req.header("authorization"));
  if (!bearer) throw new AppError("unauthenticated", "Missing bearer token", { remedy: "Send `Authorization: Bearer <token>`." });

  // Long-lived streams resolve access in a short transaction, then stream outside it.
  if (SHORT_TX_ROUTES.some((p) => p.test(path))) {
    const principal = await withTransaction((t) => resolvePrincipal(bearer, t, { activity: false, paidHeld: path === "/v1/guest/stream" }));
    c.set("principal", principal);
    return next();
  }

  // A request replayed in-process from inside another request (a proposal approval executing its
  // frozen request) already holds the outer request's slot: taking a second one could deadlock the
  // gate once TX_MAX approvals run at once. It still gets its own transaction and RLS context.
  const nested = maybeTx() != null;
  // Only an in-process replay can carry a proposal; the header from outside is ignored.
  const proposalId = nested ? c.req.header("x-proposal-id") : undefined;
  const release = nested ? () => {} : await admissionGate().acquire();
  try {
    const started = performance.now();
    // A nested replay runs inside the outer request, whose deadline covers it.
    await (nested ? withTransaction : withRequestTransaction)(async (t) => {
      const principal = await resolvePrincipal(bearer, t, { activity: !READ_METHODS.has(c.req.method) });
      c.set("principal", principal);
      await applyRls(t, principal);
      t.principal = { type: principal.type, id: principal.id, merchantId: principal.merchantId };
      if (proposalId) t.pinnedOrder = await proposalOrderPin(proposalId);
      await next();
      if (c.error) throw c.error;
      if (c.res.status >= 400 || t.dryRun) throw new RollbackSignal(c.res);
    });
    logger.debug({ requestId, path, ms: Math.round(performance.now() - started) }, "request");
  } catch (e) {
    if (e instanceof RollbackSignal) {
      if (c.get("dryRun")) c.header("x-dry-run", "true");
      return; // response already set; transaction rolled back
    }
    if (e instanceof TxDeadlineError) {
      logger.warn({ requestId, path, ms: e.ms }, "request transaction past its deadline");
      throw new AppError("overloaded", "The register did not finish this in time", { remedy: "Try again: if it went through, the register answers as it did then." });
    }
    throw e;
  } finally {
    release();
  }
};

/**
 * The outlet scope a brand scope leaves: an outlet belongs to one brand, so someone limited to some brands is limited
 * to those brands' outlets, and through the outlet policies to everything under them (tables, shifts, printers).
 * Read before the request's role is set. No outlet left is the empty scope, which matches no outlet; never '*'.
 */
async function outletScopeWithinBrands(t: RequestTx, principal: Principal): Promise<string> {
  const scope = outletScopeFor(principal);
  const brandScope = brandScopeFor(principal);
  if (brandScope === "*") return scope;
  const rows = await t.sql<{ id: string }[]>`select id from outlets where merchant_id = ${principal.merchantId} and brand_id = any(${brandScope.split(",")}::uuid[])`;
  const own = scope === "*" ? null : new Set(scope.split(","));
  return rows.map((r) => r.id).filter((id) => !own || own.has(id)).join(",");
}

export async function applyRls(t: RequestTx, principal: Principal) {
  const role = principalRole(principal);
  const outletScope = await outletScopeWithinBrands(t, principal);
  await t.sql`select
    set_config('app.current_merchant', ${principal.merchantId}, true),
    set_config('app.current_outlets', ${outletScope}, true),
    set_config('app.current_brands', ${brandScopeFor(principal)}, true),
    set_config('app.current_principal', ${principal.id}, true),
    set_config('app.current_principal_type', ${principal.type}, true),
    set_config('app.current_role', ${role ?? ""}, true),
    set_config('app.current_order', ${principal.type === "guest" ? (principal.orderId ?? "") : ""}, true)`;
  await t.sql.unsafe(`set local role ${dbRoleFor(principal)}`);
}

export function readBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : null;
}
