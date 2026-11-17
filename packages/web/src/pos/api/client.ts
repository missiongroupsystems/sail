import { createApi, createRequestTracker, type ApiClient, type RequestTracker } from "@/lib/api";

/** The register client, plus its requests on the wire, which a lock stops before it ends the PIN session. */
export type PosApi = ApiClient & { requests?: RequestTracker };

/** The register's address for the browser: the POS talks to it directly with Bearer tokens (CORS is open). */
export const POS_API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080").replace(/\/+$/, "");

export type PosApiOptions = {
  baseUrl?: string;
  /** Read on every request, so the same client follows the station token, then each PIN session. */
  getToken: () => string | null;
  /** The register rejected the token (401), with its answer. The POS locks or re-pairs; the error still propagates. */
  onUnauthenticated?: (response: Response) => void;
  timeoutMs?: number;
};

/**
 * The POS client: the shared `createApi` conventions (30 s timeout, automatic
 * Idempotency-Key, `ApiError` on failure) plus a token that can change without
 * rebuilding the client.
 */
export function createPosApi({ baseUrl = POS_API_URL, getToken, onUnauthenticated, timeoutMs = 15_000 }: PosApiOptions): PosApi {
  const requests = createRequestTracker();
  const client: PosApi = Object.assign(createApi({ baseUrl, token: null, timeoutMs, tracker: requests }), { requests });
  client.use({
    onRequest({ request }) {
      // A call that names its own token keeps it: ending a session the station has already locked sends that session's token.
      const token = getToken();
      if (token && !request.headers.has("authorization")) request.headers.set("authorization", `Bearer ${token}`);
      return request;
    },
    onResponse({ response }) {
      if (response.status === 401) onUnauthenticated?.(response.clone());
      return response;
    },
  });
  return client;
}
