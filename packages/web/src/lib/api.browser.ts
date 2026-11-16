import { createApi, createRequestTracker } from "./api";

/**
 * The browser client. It talks to the Next proxy at /api/v1/*, which adds the
 * bearer token from the httpOnly session cookie, so no token ever reaches
 * client-side JavaScript. Every piece of data still comes from the register.
 */
/** Sign-out closes it before the session ends, so no request goes out with an ended session (identity.spec.ts). */
export const browserRequests = createRequestTracker();
export const api = createApi({ baseUrl: "/api", tracker: browserRequests });
