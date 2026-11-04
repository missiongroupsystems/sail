import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { closePool } from "./db/client.js";
import { startListener, stopListener } from "./sse/listener.js";

/**
 * One image, role flags (Launchpad pattern): `node dist/index.js --role=app|worker|mcp`.
 */
const role = (process.argv.find((a) => a.startsWith("--role="))?.slice("--role=".length) ?? process.env.SAIL_ROLE ?? "app") as "app" | "worker" | "mcp";
process.env.SAIL_ROLE = role;

async function main() {
  const cfg = config();
  // Phase modules register routes, resolvers and worker tasks at import time.
  await import("./modules.js");

  if (role === "app") {
    const { buildApp } = await import("./app.js");
    const app = buildApp();
    await startListener();
    const server = serve({ fetch: app.fetch, port: cfg.PORT }, (info) => logger.info({ port: info.port }, "sail api listening"));
    shutdown(async () => {
      server.close();
      await stopListener();
      await closePool();
    });
  } else if (role === "worker") {
    const { runWorker } = await import("./worker/index.js");
    const stop = await runWorker();
    shutdown(async () => {
      await stop();
      await closePool();
    });
  } else if (role === "mcp") {
    const { startMcpServer } = await import("./mcp/index.js");
    const stop = await startMcpServer(cfg.PORT);
    shutdown(async () => {
      await stop();
      await closePool();
    });
  } else {
    throw new Error(`Unknown role ${role}`);
  }
}

function shutdown(fn: () => Promise<void>) {
  let called = false;
  const handler = async (signal: string) => {
    if (called) return;
    called = true;
    logger.info({ signal }, "shutting down");
    try {
      await fn();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void handler("SIGTERM"));
  process.on("SIGINT", () => void handler("SIGINT"));
}

main().catch((e) => {
  logger.fatal({ err: e }, "fatal");
  process.exit(1);
});
