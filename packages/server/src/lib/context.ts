import type { Context } from "hono";
import type { Principal } from "../auth/principal.js";

/** Hono environment: variables set by the request pipeline. */
export type AppEnv = {
  Variables: {
    principal: Principal;
    requestId: string;
    correlationId: string;
    idempotencyKey: string | null;
    dryRun: boolean;
    operationId: string;
  };
};

export type AppContext = Context<AppEnv>;
