import { z } from "zod";

/**
 * Environment configuration. Variables are listed in docs/self-hosting.md;
 * nothing here has a production default.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(8080),
  LOG_LEVEL: z.string().default("info"),

  /** Supabase transaction pooler (port 6543). Used for every request transaction, with prepare:false. */
  DATABASE_URL: z.string().min(1),
  /** Session connection (port 5432) for LISTEN, session-level advisory locks and migrations. */
  LISTEN_DATABASE_URL: z.string().min(1).optional(),
  /** Tests and local development may set this to allow a non-5432 LISTEN URL. */
  ALLOW_POOLER_LISTEN: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),

  DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
  /** Admission gate: concurrent request transactions, then a queue, then 503. */
  TX_MAX: z.coerce.number().int().min(1).default(6),
  QUEUE_MAX: z.coerce.number().int().min(0).default(64),
  /** How long a queued request waits for a slot before a 503. */
  QUEUE_WAIT_MS: z.coerce.number().int().min(100).default(10_000),

  CORS_ORIGIN: z.string().default("*"),

  /**
   * Back-office sign-in through an external OIDC issuer: JWTs verified against the issuer's JWKS, or an HS256 secret.
   * Setting either selects the `oidc` identity provider; leaving both unset selects `local` (email and password).
   */
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_JWT_SECRET: z.string().optional(),
  /** Signs back-office sessions issued by the `local` identity provider. */
  SESSION_TOKEN_SECRET: z.string().min(16).optional(),
  /**
   * Take the client address for sign-in lockout from the last `X-Forwarded-For` entry. Set it only when every request
   * reaches the API through a proxy that sets that header (the web app's sign-in does); otherwise a caller could pick
   * its own address.
   */
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),

  /** Sail-issued tokens (station, PIN session, guest, relay, agent). */
  STATION_TOKEN_SECRET: z.string().min(16).optional(),
  GUEST_TOKEN_SECRET: z.string().min(16).optional(),
  RELAY_TOKEN_SECRET: z.string().min(16).optional(),
  AGENT_TOKEN_SECRET: z.string().min(16).optional(),

  /** PIN sessions expire after this many seconds of inactivity. */
  PIN_SESSION_IDLE_SECONDS: z.coerce.number().int().default(15 * 60),
  /** Base URL of the guest ordering app, used in QR codes. */
  GUEST_APP_URL: z.string().default("http://localhost:3001"),
  /** Base URL of the web app, used in digital receipt links. */
  WEB_APP_URL: z.string().default("http://localhost:3000"),
  /** Development and tests: the terminal simulator the `simulator` payment provider talks to (scripts/payment-simulator.ts). */
  PAYMENT_SIMULATOR_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.LISTEN_DATABASE_URL && !cfg.ALLOW_POOLER_LISTEN) {
    const port = safePort(cfg.LISTEN_DATABASE_URL);
    if (port !== 5432) throw new Error(`LISTEN_DATABASE_URL must use the session connection on port 5432, got ${port ?? "unknown"}`);
  }
  return cfg;
}

/** The back-office identity provider: `oidc` when an external issuer is configured, `local` otherwise. */
export function identityProviderKind(cfg: Env = config()): "local" | "oidc" {
  return cfg.SUPABASE_URL || cfg.SUPABASE_JWT_SECRET ? "oidc" : "local";
}

export function config(): Env {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Tests inject their own configuration. */
export function setConfigForTests(cfg: Env) {
  cached = cfg;
}

export function safePort(url: string): number | null {
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
    return u.protocol.startsWith("postgres") ? 5432 : null;
  } catch {
    return null;
  }
}
