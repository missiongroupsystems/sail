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
    /** The response carries a secret shown once (a sign-in link): an idempotent replay must not return it again. */
    secretResult: boolean;
  };
};

export type AppContext = Context<AppEnv>;
