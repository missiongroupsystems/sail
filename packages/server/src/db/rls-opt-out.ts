/**
 * Routes that run with NO per-request RLS transaction (
 * `/health` only, plus the spec itself, the public sign-in, setup and pairing
 * endpoints, which run their own transaction, and payment provider webhooks,
 * which carry a signature instead of a token). Covered by a test.
 */
export const RLS_OPT_OUT: RegExp[] = [/^\/health$/, /^\/openapi\.json$/, /^\/v1\/auth\/status$/, /^\/v1\/auth\/sign-in$/, /^\/v1\/auth\/links\/accept$/, /^\/v1\/setup$/, /^\/v1\/guest\/sessions$/, /^\/v1\/agent-sessions$/, /^\/v1\/stations\/pair$/, /^\/v1\/relays\/pair$/, /^\/v1\/receipts\/[^/]+$/, /^\/v1\/webhooks\/payments\/[^/]+\/[^/]+$/];

/**
 * Long-lived stream routes. They still authenticate and check access under RLS,
 * but in a short transaction, because the stream itself must not hold one.
 */
export const SHORT_TX_ROUTES: RegExp[] = [/^\/v1\/outlets\/[^/]+\/stream$/, /^\/v1\/relays\/[^/]+\/stream$/, /^\/v1\/guest\/stream$/];
