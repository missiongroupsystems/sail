import { HTTP_STATUS_FOR_CODE, type ApiErrorBody, type ErrorCode } from "@sail/shared";

/**
 * The one error type routes throw. The `onError` handler turns it into the
 * shared `{ code, message, remedy, details }` body with the matching status.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly remedy: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  readonly status: number;

  constructor(code: ErrorCode, message: string, opts: { remedy?: string; details?: Record<string, unknown>; status?: number } = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.remedy = opts.remedy;
    this.details = opts.details;
    this.status = opts.status ?? HTTP_STATUS_FOR_CODE[code];
  }

  toBody(): ApiErrorBody {
    const body: ApiErrorBody = { code: this.code, message: this.message };
    if (this.remedy) body.remedy = this.remedy;
    if (this.details) body.details = this.details;
    return body;
  }

  static notFound(what: string, id?: string) {
    return new AppError("not_found", id ? `${what} ${id} was not found` : `${what} was not found`, {
      remedy: "Check the ID, and that it belongs to your merchant and outlet.",
    });
  }
  static permission(requiredRole: string, overrideAllowed: boolean, action: string) {
    return new AppError("permission_denied", `${action} needs ${requiredRole} or above`, {
      remedy: overrideAllowed ? "Ask a manager to approve this action (manager override)." : "Ask someone with the required role.",
      details: { required_role: requiredRole, override_allowed: overrideAllowed, action },
    });
  }
  /**
   * `extra` may carry a `remedy` (shown to the user) and `details`, or be the details themselves;
   * either way the remedy ends up on the error, not buried inside details.
   */
  static validation(message: string, extra?: Record<string, unknown>) {
    if (!extra) return new AppError("validation", message);
    const { remedy, details, ...rest } = extra;
    const merged = { ...((details && typeof details === "object" ? details : {}) as Record<string, unknown>), ...rest };
    return new AppError("validation", message, { remedy: typeof remedy === "string" ? remedy : undefined, details: Object.keys(merged).length ? merged : undefined });
  }
  static state(message: string, allowed: string[], remedy?: string) {
    return new AppError("state_conflict", message, { remedy, details: { allowed_transitions: allowed } });
  }
  static invariant(name: string, message: string, remedy?: string) {
    return new AppError("invariant_violation", message, { remedy, details: { invariant: name } });
  }
  static version(message = "The order was changed by someone else", details?: Record<string, unknown>) {
    return new AppError("version_conflict", message, { remedy: "Reload the current version and apply your change again.", details });
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
