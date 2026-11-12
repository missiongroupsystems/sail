/**
 * Routes that run with NO per-request RLS transaction (
 * `/health` only, plus the spec itself and the development token endpoint,
 * which is disabled in production). Covered by a test.
 */
export const RLS_OPT_OUT: RegExp[] = [/^\/health$/, /^\/openapi\.json$/, /^\/v1\/auth\/dev-token$/, /^\/v1\/guest\/sessions$/, /^\/v1\/agent-sessions$/, /^\/v1\/stations\/pair$/, /^\/v1\/relays\/pair$/, /^\/v1\/receipts\/[^/]+$/];

/**
 * Long-lived stream routes. They still authenticate and check access under RLS,
 * but in a short transaction, because the stream itself must not hold one.
 */
export const SHORT_TX_ROUTES: RegExp[] = [/^\/v1\/outlets\/[^/]+\/stream$/, /^\/v1\/relays\/[^/]+\/stream$/, /^\/v1\/guest\/stream$/];
