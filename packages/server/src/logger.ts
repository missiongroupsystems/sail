import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "warn" : "info"),
  base: { service: "sail-server", role: process.env.SAIL_ROLE ?? "app" },
  redact: ["req.headers.authorization", "*.pin", "*.token"],
});

export type Logger = typeof logger;
