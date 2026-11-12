import type { MiddlewareHandler } from "hono";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, tx } from "../db/client.js";
import { idempotencyKeys } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import type { AppEnv } from "../lib/context.js";
import { RLS_OPT_OUT, SHORT_TX_ROUTES } from "../db/rls-opt-out.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Idempotency-Key on every mutation. The key is scoped to
 * the principal. A repeat with the same body replays the stored response; the
 * same key with a different body is `idempotency_conflict`.
 *
 * Runs inside the request transaction. The key row is inserted before the
 * handler, so two concurrent requests with the same key serialise on the
 * primary key: the second waits for the first to commit, then replays it.
 */
export const idempotency: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = c.req.path;
  if (!MUTATING.has(c.req.method) || RLS_OPT_OUT.some((p) => p.test(path)) || SHORT_TX_ROUTES.some((p) => p.test(path))) {
    c.set("idempotencyKey", null);
    return next();
  }
  const key = c.req.header("idempotency-key");
  if (!key) throw new AppError("validation", "Idempotency-Key header is required on every mutation", { remedy: "Send a unique Idempotency-Key (for example a UUID) and reuse it when retrying the same request." });
  if (key.length > 200) throw new AppError("validation", "Idempotency-Key is too long");
  c.set("idempotencyKey", key);

  const principal = c.get("principal");
  const body = await c.req.raw.clone().text();
  const hash = createHash("sha256").update(`${c.req.method}\n${path}\n${body}`).digest("hex");

  const [existing] = await db()
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.principalId, principal.id), eq(idempotencyKeys.key, key)))
    .limit(1);
  if (existing) return replay(c, existing, hash);

  // The insert runs in a savepoint: a unique-key failure would otherwise abort the whole request
  // transaction and the replay lookup below could not run.
  const raced = await tx()
    .savepoint((s) => s`insert into idempotency_keys (merchant_id, principal_id, key, request_hash) values (${principal.merchantId}, ${principal.id}, ${key}, ${hash})`)
    .then(() => false)
    .catch((e: { code?: string }) => {
      if (e.code === "23505") return true;
      throw e;
    });
  if (raced) {
    // Lost a race: another transaction inserted the same key and has committed (the insert waited on its lock). Replay it.
    const [row] = await db()
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.principalId, principal.id), eq(idempotencyKeys.key, key)))
      .limit(1);
    if (row) return replay(c, row, hash);
    throw new AppError("state_conflict", "A request with this Idempotency-Key is still being processed", { remedy: "Retry in a moment with the same key." });
  }

  await next();

  const res = c.res;
  if (res.status < 400) {
    const text = await res.clone().text();
    let stored: unknown = text;
    try {
      stored = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body stored as text */
    }
    await tx()`update idempotency_keys set status = ${res.status}, body = ${JSON.stringify(stored)}::jsonb where principal_id = ${principal.id} and key = ${key}`;
  }
};

function replay(c: Parameters<MiddlewareHandler<AppEnv>>[0], row: typeof idempotencyKeys.$inferSelect, hash: string): Response {
  if (row.requestHash !== hash) {
    throw new AppError("idempotency_conflict", "This Idempotency-Key was already used with a different request", { remedy: "Use a new key for a new request; reuse a key only to retry the identical request." });
  }
  if (row.status == null) {
    // The first request is still in flight (or failed before storing). Ask the client to retry.
    throw new AppError("state_conflict", "A request with this Idempotency-Key is still being processed", { remedy: "Retry in a moment with the same key." });
  }
  c.header("idempotent-replayed", "true");
  return c.json(row.body as never, row.status as 200);
}
