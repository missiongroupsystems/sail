import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "./api/schema";
import type { CompiledMenu, GuestSession, OrderView, ReceiptRead, RoundInput, RoundResult } from "./types";

/** The register's address for the phone's browser (CORS is open; the guest token goes in the Bearer header). */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080").replace(/\/+$/, "");

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
      // Modifier validation errors carry their remedy inside `details` (server lines.ts); surface it either way.
      const detailRemedy = typeof b.details?.remedy === "string" ? b.details.remedy : undefined;
      return new ApiError({ code: b.code ?? "internal", message: b.message, remedy: b.remedy ?? detailRemedy, details: b.details }, status);
    }
    return new ApiError(
      { code: status === 401 ? "unauthenticated" : status === 404 ? "not_found" : status >= 500 ? "internal" : "validation", message: `The register replied with status ${status}`, remedy: "Try again." },
      status,
    );
  }

  static timeout(ms: number): ApiError {
    return new ApiError({ code: "unavailable", message: `No reply within ${Math.round(ms / 1000)} seconds`, remedy: "Check your connection and try again." }, 0);
  }

  static network(cause: unknown): ApiError {
    return new ApiError({ code: "unavailable", message: "Could not reach the restaurant", remedy: "Check your connection and try again." }, 0, { cause });
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isRateLimited(): boolean {
    return this.status === 429 || this.code === "rate_limited";
  }
  /** `details.retry_after_seconds` from a 429, or null. */
  get retryAfterSeconds(): number | null {
    const v = this.details?.retry_after_seconds;
    return typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.ceil(v)) : null;
  }
  /** `details.group_id` from a modifier validation error, so the message can sit on the offending choice. */
  get groupId(): string | null {
    const v = this.details?.group_id;
    return typeof v === "string" ? v : null;
  }
  get productId(): string | null {
    const v = this.details?.product_id;
    return typeof v === "string" ? v : null;
  }
  get tableNotOpen(): boolean {
    return this.code === "state_conflict" && this.details?.table_not_open === true;
  }
}

/** Narrow an unknown caught value to an error the UI can show with its remedy. */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof Error) return new ApiError({ code: "internal", message: e.message }, 0, { cause: e });
  return new ApiError({ code: "internal", message: "Unexpected error" }, 0);
}

export const DEFAULT_TIMEOUT_MS = 15_000;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type GuestApiOptions = {
  baseUrl?: string;
  /** Read on every request, so one client follows the session token as it is created or replaced. */
  getToken: () => string | null;
  /** The register rejected the token (401): the table session has ended. The error still propagates. */
  onUnauthenticated?: (error: ApiError) => void;
  timeoutMs?: number;
};

/**
 * The guest client: openapi-fetch with Sail's conventions. A 15 s timeout, an
 * automatic `Idempotency-Key` on every mutation (pass the header yourself to
 * retry one), and errors thrown as `ApiError` so `data` is present on success.
 */
export function createGuestApi({ baseUrl = API_URL, getToken, onUnauthenticated, timeoutMs = DEFAULT_TIMEOUT_MS }: GuestApiOptions) {
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
      const token = getToken();
      if (token && !request.headers.has("authorization")) request.headers.set("authorization", `Bearer ${token}`);
      if (MUTATING.has(request.method) && !request.headers.has("idempotency-key")) request.headers.set("idempotency-key", uuid());
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
      const error = ApiError.from(response.status, body);
      if (response.status === 401) onUnauthenticated?.(error);
      throw error;
    },
  };
  client.use(conventions);
  return client;
}

export type GuestApi = ReturnType<typeof createGuestApi>;

/** A UUID v4, also in insecure contexts (a phone on the outlet's LAN over plain http has no `crypto.randomUUID`). */
export function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ---- The guest endpoints. Public: sessions and receipts; the rest carry the guest Bearer token. ---- */

/** Exchanges the table's QR token for a 4-hour guest token. Public; rate-limited per device and table. */
export async function createSession(api: GuestApi, body: { token: string; device_id: string; guest_name?: string }): Promise<GuestSession> {
  const res = await api.POST("/v1/guest/sessions", { body, headers: { authorization: "" } });
  return res.data!.data as GuestSession;
}

/** The channel link's compiled menu: sections, products with menu prices, modifier groups, availability and the brand. */
export async function getMenu(api: GuestApi, channelLinkId: string): Promise<CompiledMenu> {
  const res = await api.GET("/v1/channel-links/{id}/menu", { params: { path: { id: channelLinkId } } });
  return res.data!.data as unknown as CompiledMenu;
}

/** What the table has ordered: lines (menu prices only), rounds and this guest's requests. */
export async function getOrder(api: GuestApi): Promise<OrderView> {
  const res = await api.GET("/v1/guest/order");
  return res.data!.data as unknown as OrderView;
}

/** Sends a round. Pass the same `round_id` and `idempotencyKey` when retrying the same basket. */
export async function submitRound(api: GuestApi, body: RoundInput, idempotencyKey: string): Promise<RoundResult> {
  const res = await api.POST("/v1/guest/rounds", { body, headers: { "idempotency-key": idempotencyKey } });
  return res.data!.data as unknown as RoundResult;
}

/** Calls staff: one of the channel's requests, or `call_for_bill`. The register allows one per type per minute. */
export async function createRequest(api: GuestApi, type: string, guestName?: string): Promise<Record<string, unknown>> {
  const res = await api.POST("/v1/guest/requests", { body: { type, ...(guestName ? { guest_name: guestName } : {}) } });
  return res.data!.data;
}

/** A digital receipt by its link token. Public; 404 once the link has expired. */
export async function readReceipt(api: GuestApi, token: string): Promise<ReceiptRead> {
  const res = await api.GET("/v1/receipts/{token}", { params: { path: { token } }, headers: { authorization: "" } });
  return res.data!.data as unknown as ReceiptRead;
}
