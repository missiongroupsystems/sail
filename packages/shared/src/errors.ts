import { z } from "zod";

/**
 * The one error shape every client sees (vision 4.2). Errors are instructions:
 * they carry a stable code, what was involved, and a remedy.
 */
export const ERROR_CODES = [
  "validation",
  "not_found",
  "unauthenticated",
  "version_conflict",
  "idempotency_conflict",
  "permission_denied",
  "requires_confirmation",
  "invariant_violation",
  "state_conflict",
  "unavailable",
  "rate_limited",
  "budget_exceeded",
  "overloaded",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const HTTP_STATUS_FOR_CODE: Record<ErrorCode, number> = {
  validation: 400,
  unauthenticated: 401,
  permission_denied: 403,
  not_found: 404,
  state_conflict: 409,
  version_conflict: 409,
  idempotency_conflict: 409,
  invariant_violation: 422,
  unavailable: 422,
  requires_confirmation: 202,
  rate_limited: 429,
  budget_exceeded: 429,
  overloaded: 503,
  internal: 500,
};

export const ApiErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  remedy: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ApiErrorBody = z.infer<typeof ApiErrorSchema>;
