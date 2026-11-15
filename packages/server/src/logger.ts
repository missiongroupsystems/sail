import pino from "pino";

/** The process's role (`--role=app|worker|mcp`, or SAIL_ROLE), read here because the logger is built at import, before index.ts runs. */
export function processRole(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): string {
  return argv.find((a) => a.startsWith("--role="))?.slice("--role=".length) ?? env.SAIL_ROLE ?? "app";
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "warn" : "info"),
  base: { service: "sail-server", role: processRole() },
  redact: ["req.headers.authorization", "*.pin", "*.token"],
});

export type Logger = typeof logger;
