import { createApi } from "./api";

/**
 * The browser client. It talks to the Next proxy at /api/v1/*, which adds the
 * bearer token from the httpOnly session cookie, so no token ever reaches
 * client-side JavaScript. Every piece of data still comes from the register.
 */
export const api = createApi({ baseUrl: "/api" });
