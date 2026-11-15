import { createApi, type ApiClient } from "@/lib/api";

export type { ApiClient as PosApi };

/** The register's address for the browser: the POS talks to it directly with Bearer tokens (CORS is open). */
export const POS_API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080").replace(/\/+$/, "");

export type PosApiOptions = {
  baseUrl?: string;
  /** Read on every request, so the same client follows the station token, then each PIN session. */
  getToken: () => string | null;
  /** The register rejected the token (401). The POS locks or re-pairs; the error still propagates. */
  onUnauthenticated?: () => void;
  timeoutMs?: number;
};

/**
 * The POS client: the shared `createApi` conventions (30 s timeout, automatic
 * Idempotency-Key, `ApiError` on failure) plus a token that can change without
 * rebuilding the client.
 */
export function createPosApi({ baseUrl = POS_API_URL, getToken, onUnauthenticated, timeoutMs = 15_000 }: PosApiOptions): ApiClient {
  const client = createApi({ baseUrl, token: null, timeoutMs });
  client.use({
    onRequest({ request }) {
      // A call that names its own token keeps it: ending a session the station has already locked sends that session's token.
      const token = getToken();
      if (token && !request.headers.has("authorization")) request.headers.set("authorization", `Bearer ${token}`);
      return request;
    },
    onResponse({ response }) {
      if (response.status === 401) onUnauthenticated?.();
      return response;
    },
  });
  return client;
}
