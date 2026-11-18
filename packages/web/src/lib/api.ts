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

  /** Not sent: the session these requests belonged to has ended in this tab (sign-out, POS lock). */
  static sessionEnded(): ApiError {
    return new ApiError({ code: "session_ended", message: "Signed out", remedy: "Sign in again." }, 0);
  }

  /**
   * A mutation went out and no answer came back, even when asked again under the same key: it may or may not have been
   * done. The screen re-reads the register before anyone tries again.
   */
  static noAnswer(processing = false): ApiError {
    // `processing`: the register is still working on the first request (the same key is in progress there).
    return new ApiError({ code: "unavailable", message: "The register did not answer", remedy: "It may not have gone through. Check the screen, then try again.", details: { outcome_unknown: true, ...(processing ? { processing: true } : {}) } }, 0);
  }

  static network(cause: unknown): ApiError {
    return new ApiError({ code: "unavailable", message: "The register could not be reached", remedy: "Check the connection and that the API is running, then try again." }, 0, { cause });
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

/** The register's answer to a mutation was lost twice: it may or may not have been done (see `ApiError.noAnswer`). */
export function outcomeUnknown(e: unknown): boolean {
  return e instanceof ApiError && e.details?.outcome_unknown === true;
}

/** Narrow an unknown caught value to an error the UI can show with its remedy. */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof Error) return new ApiError({ code: "internal", message: e.message }, 0, { cause: e });
  return new ApiError({ code: "internal", message: "Unexpected error" }, 0);
}

export const DEFAULT_TIMEOUT_MS = 30_000;
/** Told when a mutation's outcome is unknown (`ApiError.noAnswer`): the POS and kitchen display re-read what they show. */
const unknownOutcomeListeners = new Set<() => void>();
export function onOutcomeUnknown(listener: () => void): () => void {
  unknownOutcomeListeners.add(listener);
  return () => void unknownOutcomeListeners.delete(listener);
}
const noAnswer = (processing = false): ApiError => {
  for (const l of unknownOutcomeListeners) l();
  return ApiError.noAnswer(processing);
};
/**
 * Mutations the register keeps no answer for (they run outside its idempotency store: sign-in, set-up, pairing with a
 * one-time code). Asking again would do them a second time, so a lost answer there is reported as it is.
 */
const NO_STORED_ANSWER = [/\/v1\/auth\//, /\/v1\/setup$/, /\/v1\/stations\/pair$/, /\/v1\/relays\/pair$/, /\/v1\/guest\/sessions$/, /\/v1\/agent-sessions$/];
/** How long the second ask of a lost mutation waits: the register only has to replay the stored answer, or do it now. */
const REPLAY_TIMEOUT_MS = 8_000;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * A double click: a mutation sent again, word for word, while the first is on the wire or just answered. It shares the
 * first one's answer instead of reaching the register with a new Idempotency-Key and creating a second record. Only
 * mutations whose key is made here take part (a caller that passes its own key decides for itself), and only in the
 * browser, where one person is behind the client.
 */
const autoKeyed = new WeakSet<Request>();
const inFlight = new Map<string, Promise<Response>>();
const SHARE_ANSWER_MS = 1000;

type Live = { request: Request; controller: AbortController; settled: Promise<unknown> };

/**
 * The requests one browser client has on the wire. Ending a session goes through here first, so nothing that carries
 * the session is still in flight, or sent, after the register ends it: a read on the wire is cancelled, a write is
 * waited for (it may already have changed the register), and with `close` every later request is refused unsent.
 */
export type RequestTracker = {
  /** Cancel the reads and wait for the writes that `match` picks (all by default). */
  drain(match?: (request: Request) => boolean): Promise<void>;
  /** Drain everything and refuse every later request: this tab's session is over until the page reloads. */
  close(): Promise<void>;
  readonly closed: boolean;
  /** Internal: wraps one send. */
  run(request: Request, controller: AbortController, send: () => Promise<Response>): Promise<Response>;
};

export function createRequestTracker(): RequestTracker {
  const live = new Set<Live>();
  let closed = false;
  const drain = async (match: (request: Request) => boolean = () => true) => {
    const writes: Promise<unknown>[] = [];
    for (const l of live) {
      if (!match(l.request)) continue;
      if (MUTATING.has(l.request.method)) writes.push(l.settled);
      else l.controller.abort(ApiError.sessionEnded());
    }
    await Promise.allSettled(writes);
  };
  return {
    drain,
    async close() {
      closed = true;
      await drain();
    },
    get closed() {
      return closed;
    },
    async run(request, controller, send) {
      if (closed) throw ApiError.sessionEnded();
      const answer = send();
      const entry: Live = { request, controller, settled: answer.catch(() => undefined) };
      live.add(entry);
      try {
        return await answer;
      } finally {
        live.delete(entry);
      }
    },
  };
}

export type ApiClientOptions = {
  /** "http://localhost:8080" on the server; "/api" in the browser (the Next proxy). */
  baseUrl: string;
  /** Bearer token. The browser never holds one; the proxy adds it from the httpOnly cookie. */
  token?: string | null;
  /** Extra request headers, such as the browser's address on sign-in. */
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Browser clients only: lets sign-out and lock stop this client's requests before the session ends. */
  tracker?: RequestTracker;
};

/**
 * The generated client with Sail's conventions: a 30 s timeout, an automatic
 * `Idempotency-Key` on every mutation (reuse one by passing the header yourself
 * when retrying), and errors thrown as `ApiError` so `data` is always present on
 * a resolved call.
 */
export function createApi({ baseUrl, token, headers, timeoutMs = DEFAULT_TIMEOUT_MS, tracker }: ApiClientOptions) {
  const timedFetch = async (request: Request): Promise<Response> => {
    if (!autoKeyed.has(request)) return send(request);
    // The body is read once, as bytes, and sent as bytes: a request cloned to read it would go out as a stream.
    const body = await request.arrayBuffer();
    const same = `${request.method} ${request.url}\n${request.headers.get("authorization") ?? ""}\n${new TextDecoder().decode(body)}`;
    request = new Request(request, { body });
    const first = inFlight.get(same);
    if (first) return (await first).clone();
    const answer = send(request);
    inFlight.set(same, answer);
    answer.then(
      () => setTimeout(() => inFlight.delete(same), SHARE_ANSWER_MS),
      () => inFlight.delete(same),
    );
    return (await answer).clone();
  };
  /**
   * One attempt. The deadline covers the whole answer, body included: a reply whose headers arrive and whose body
   * never does is abandoned like one that never starts (review 4 U1, a Reject that spun for two minutes).
   */
  const attempt = async (request: Request, ms: number): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(ApiError.timeout(ms)), ms);
    const upstream = request.signal;
    if (upstream.aborted) controller.abort(upstream.reason);
    else upstream.addEventListener("abort", () => controller.abort(upstream.reason), { once: true });
    const whole = async () => {
      const res = await fetch(request, { signal: controller.signal });
      const body = res.status === 204 || res.status === 304 ? null : await res.arrayBuffer();
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    };
    try {
      if (tracker) return await tracker.run(request, controller, whole);
      return await whole();
    } catch (e) {
      // Refused unsent by the tracker (the session has ended): say so, not "could not be reached".
      if (e instanceof ApiError) throw e;
      const reason: unknown = controller.signal.reason;
      if (controller.signal.aborted && reason instanceof ApiError) throw reason;
      throw ApiError.network(e);
    } finally {
      clearTimeout(timer);
    }
  };
  /**
   * A mutation whose answer is lost (no reply in time, or the connection dropped) may still have been done. It is asked
   * once more with the same Idempotency-Key: the register replays the stored answer when it was done and does it now,
   * once, when it was not. Only when that also goes unanswered does the caller hear "no answer" (`ApiError.noAnswer`),
   * and then it re-reads what it shows rather than guess. Requests are never sent twice under two keys.
   */
  const send = async (request: Request): Promise<Response> => {
    if (!MUTATING.has(request.method) || !request.headers.has("idempotency-key") || NO_STORED_ANSWER.some((r) => r.test(new URL(request.url).pathname))) return attempt(request, timeoutMs);
    // The body is read once and each ask carries it as bytes: a cloned request would send a stream instead.
    const body = await request.arrayBuffer();
    const ask = () => new Request(request, { body });
    try {
      return await attempt(ask(), timeoutMs);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 0 || e.code !== "unavailable" || request.signal.aborted || tracker?.closed) throw e;
      try {
        const res = await attempt(ask(), REPLAY_TIMEOUT_MS);
        // Still being worked on by the first request: the outcome is not known yet.
        if (res.status === 409) {
          const text = await res.clone().text();
          if (/still being processed/.test(text)) throw noAnswer(true);
          // Done, but its answer held a secret the register shows only once (a receipt QR, a pairing code): it cannot be
          // replayed, so the screen re-reads rather than show the register's note about keys.
          if (/result was shown once/.test(text)) throw noAnswer();
        }
        return res;
      } catch (e2) {
        if (e2 instanceof ApiError && e2.status === 0 && e2.code === "unavailable") throw e2.details?.outcome_unknown ? e2 : noAnswer();
        throw e2;
      }
    }
  };

  const client = createClient<paths>({ baseUrl, fetch: timedFetch });

  const conventions: Middleware = {
    onRequest({ request }) {
      if (token) request.headers.set("authorization", `Bearer ${token}`);
      for (const [name, value] of Object.entries(headers ?? {})) request.headers.set(name, value);
      if (MUTATING.has(request.method) && !request.headers.has("idempotency-key")) {
        request.headers.set("idempotency-key", crypto.randomUUID());
        if (typeof window !== "undefined") autoKeyed.add(request);
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
