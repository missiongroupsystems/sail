import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from "jose";
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";

/**
 * Token types. All are plain bearer tokens.
 *
 * - Back-office users: a `session` token from the local identity provider, or a JWT from the external OIDC issuer
 *   (JWKS or HS256); which one depends on the configured provider (auth/identity.ts).
 * - Sail-issued tokens: HS256 JWTs with a `typ` claim, each signed with its own secret.
 */
export type SailTokenType = "station" | "pin" | "guest" | "relay" | "agent" | "session";

export type SailClaimsInput = {
  typ: SailTokenType;
  merchant_id: string;
  outlet_id?: string;
  station_id?: string;
  staff_id?: string;
  session_id?: string;
  relay_id?: string;
  table_id?: string;
  order_id?: string;
  channel_link_id?: string;
  brand_id?: string;
  identity_id?: string;
  on_behalf_of?: string;
  role?: string;
};
export type SailClaims = JWTPayload & SailClaimsInput;

const ISSUER = "sail";

function secretFor(typ: SailTokenType): Uint8Array {
  const cfg = config();
  const map: Record<SailTokenType, string | undefined> = {
    station: cfg.STATION_TOKEN_SECRET,
    pin: cfg.STATION_TOKEN_SECRET,
    guest: cfg.GUEST_TOKEN_SECRET,
    relay: cfg.RELAY_TOKEN_SECRET,
    agent: cfg.AGENT_TOKEN_SECRET,
    session: cfg.SESSION_TOKEN_SECRET,
  };
  const s = map[typ];
  if (!s) throw new Error(`No secret configured for ${typ} tokens`);
  return new TextEncoder().encode(s);
}

export async function signSailToken(claims: SailClaimsInput, ttlSeconds: number | null): Promise<string> {
  let jwt = new SignJWT(claims as JWTPayload).setProtectedHeader({ alg: "HS256" }).setIssuer(ISSUER).setIssuedAt().setJti(randomBytes(12).toString("hex"));
  if (ttlSeconds != null) jwt = jwt.setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds);
  return jwt.sign(secretFor(claims.typ));
}

/** Peek at the unverified `typ` claim to pick the right secret. */
export function peekTokenType(token: string): SailTokenType | "external" | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { typ?: string; iss?: string };
    if (payload.iss === ISSUER && payload.typ) return payload.typ as SailTokenType;
    return "external";
  } catch {
    return null;
  }
}

export async function verifySailToken(token: string, typ: SailTokenType): Promise<SailClaims> {
  try {
    const { payload } = await jwtVerify(token, secretFor(typ), { issuer: ISSUER });
    if (payload.typ !== typ) throw new Error("wrong token type");
    return payload as SailClaims;
  } catch (e) {
    throw new AppError("unauthenticated", `Invalid or expired ${typ} token`, { remedy: typ === "pin" ? "Sign in again with your PIN." : typ === "session" ? "Sign in again." : "Pair the device again." });
  }
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/** Verify a back-office JWT from the external OIDC issuer: its JWKS, or its HS256 secret. */
export async function verifyBackOfficeToken(token: string): Promise<{ sub: string; email?: string; emailVerified?: boolean }> {
  const cfg = config();
  const attempts: (() => Promise<JWTPayload>)[] = [];
  if (cfg.SUPABASE_URL) {
    attempts.push(async () => {
      jwks ??= createRemoteJWKSet(new URL(`${cfg.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
      return (await jwtVerify(token, jwks)).payload;
    });
  }
  if (cfg.SUPABASE_JWT_SECRET) {
    const key = new TextEncoder().encode(cfg.SUPABASE_JWT_SECRET);
    attempts.push(async () => (await jwtVerify(token, key)).payload);
  }
  if (attempts.length === 0) throw new AppError("unauthenticated", "Back-office authentication is not configured");
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      const payload = await attempt();
      if (!payload.sub) throw new Error("missing sub");
      return { sub: payload.sub, email: typeof payload.email === "string" ? payload.email : undefined, emailVerified: typeof payload.email_verified === "boolean" ? payload.email_verified : undefined };
    } catch (e) {
      lastError = e;
    }
  }
  throw new AppError("unauthenticated", "Invalid or expired sign-in", { remedy: "Sign in again.", details: { cause: String((lastError as Error)?.message ?? lastError) } });
}

/* ---- Hashing helpers for PINs, passwords, pairing codes and device tokens ---------- */

export function hashSecret(value: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(value, salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifySecret(value: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = scryptSync(value, salt, 32);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/** Fast one-way hash for high-entropy tokens (table QR tokens, relay tokens). */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function randomDigits(n: number): string {
  let s = "";
  while (s.length < n) s += randomBytes(1)[0]! % 10;
  return s.slice(0, n);
}

/** Indexed PIN lookup value: HMAC(secret, merchant:pin). A database leak alone cannot brute-force PINs without the server secret. */
export function pinLookup(merchantId: string, pin: string): string {
  const cfg = config();
  const secret = cfg.STATION_TOKEN_SECRET ?? "sail-pin-lookup";
  return createHmac("sha256", secret).update(`${merchantId}:${pin}`).digest("hex");
}
