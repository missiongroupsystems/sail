import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "./api/schema";

/** The one error shape every client sees (shared/errors.ts), plus the HTTP status. */
export type ApiErrorBody = {
  code: string;
  message: string;
  remedy?: string;
  details?: Record<string, unknown>;
};

export class ApiError extends Error {
  readonly code: string;
  readonly remedy: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  /** HTTP status; 0 when the register could not be reached at all. */
  readonly status: number;

  constructor(body: ApiErrorBody, status: number, options?: { cause?: unknown }) {
    super(body.message, options);
    this.name = "ApiError";
    this.code = body.code;
    this.remedy = body.remedy;
    this.details = body.details;
    this.status = status;
  }

  static from(status: number, body: unknown): ApiError {
    if (body && typeof body === "object" && typeof (body as ApiErrorBody).message === "string") {
      const b = body as ApiErrorBody;
      return new ApiError({ code: b.code ?? "internal", message: b.message, remedy: b.remedy, details: b.details }, status);
    }
    return new ApiError(
      { code: status === 401 ? "unauthenticated" : status >= 500 ? "internal" : "validation", message: `The register replied with status ${status}`, remedy: status === 401 ? "Sign in again." : "Try again." },
      status,
    );
  }

  static timeout(ms: number): ApiError {
    return new ApiError({ code: "unavailable", message: `The register did not reply within ${Math.round(ms / 1000)} seconds`, remedy: "Check the connection and try again." }, 0);
  }

  static network(cause: unknown): ApiError {
    return new ApiError({ code: "unavailable", message: "The register could not be reached", remedy: "Check the connection and that the API is running, then try again." }, 0, { cause });
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

/** Narrow an unknown caught value to an error the UI can show with its remedy. */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof Error) return new ApiError({ code: "internal", message: e.message }, 0, { cause: e });
  return new ApiError({ code: "internal", message: "Unexpected error" }, 0);
}

export const DEFAULT_TIMEOUT_MS = 30_000;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type ApiClientOptions = {
  /** "http://localhost:8080" on the server; "/api" in the browser (the Next proxy). */
  baseUrl: string;
  /** Bearer token. The browser never holds one; the proxy adds it from the httpOnly cookie. */
  token?: string | null;
  /** Extra request headers, such as the browser's address on sign-in. */
  headers?: Record<string, string>;
  timeoutMs?: number;
};

/**
 * The generated client with Sail's conventions: a 30 s timeout, an automatic
 * `Idempotency-Key` on every mutation (reuse one by passing the header yourself
 * when retrying), and errors thrown as `ApiError` so `data` is always present on
 * a resolved call.
 */
export function createApi({ baseUrl, token, headers, timeoutMs = DEFAULT_TIMEOUT_MS }: ApiClientOptions) {
  const timedFetch = async (request: Request): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(ApiError.timeout(timeoutMs)), timeoutMs);
    const upstream = request.signal;
    if (upstream.aborted) controller.abort(upstream.reason);
    else upstream.addEventListener("abort", () => controller.abort(upstream.reason), { once: true });
    try {
      return await fetch(request, { signal: controller.signal });
    } catch (e) {
      const reason: unknown = controller.signal.reason;
      if (controller.signal.aborted && reason instanceof ApiError) throw reason;
      throw ApiError.network(e);
    } finally {
      clearTimeout(timer);
    }
  };

  const client = createClient<paths>({ baseUrl, fetch: timedFetch });

  const conventions: Middleware = {
    onRequest({ request }) {
      if (token) request.headers.set("authorization", `Bearer ${token}`);
      for (const [name, value] of Object.entries(headers ?? {})) request.headers.set(name, value);
      if (MUTATING.has(request.method) && !request.headers.has("idempotency-key")) {
        request.headers.set("idempotency-key", crypto.randomUUID());
      }
      request.headers.set("accept", "application/json");
      return request;
    },
    async onResponse({ response }) {
      if (response.ok) return response;
      let body: unknown = null;
      try {
        body = await response.clone().json();
      } catch {
        body = null;
      }
      throw ApiError.from(response.status, body);
    },
  };
  client.use(conventions);
  return client;
}

export type ApiClient = ReturnType<typeof createApi>;

/** Unwraps an openapi-fetch result. Errors have already been thrown as `ApiError`, so `data` is present. */
export async function req<T extends { data?: unknown }>(call: Promise<T>): Promise<NonNullable<T["data"]>> {
  const res = await call;
  return res.data as NonNullable<T["data"]>;
}

/** A fresh key for one logical mutation; pass it as `headers: { "Idempotency-Key": key }` to retry safely. */
export function idempotencyKey(): string {
  return crypto.randomUUID();
}
