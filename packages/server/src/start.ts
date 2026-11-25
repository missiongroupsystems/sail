import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { config } from "./config.js";
import { logger, processRole } from "./logger.js";
import { closePool } from "./db/client.js";
import { startListener, stopListener } from "./sse/listener.js";

export type StartOptions = {
  /**
   * Extra modules, loaded after Sail's own and before the app, worker or MCP server is built. Like Sail's
   * modules, each registers routes, manifest operations, worker tasks or hooks when it is imported.
   */
  modules?: Array<() => Promise<unknown>>;
};

/** A started role: the port it listens on (app and mcp) and how to stop it. */
export type Started = { port?: number; stop: () => Promise<void> };

/** Sail's own modules, then the extra ones in order. Each registers what it adds when it is imported. */
export async function loadModules(modules: StartOptions["modules"] = []) {
  await import("./modules.js");
  for (const load of modules) await load();
}

/**
 * Starts one role of the register: `--role=app|worker|mcp`. `index.ts` calls it with no extra modules; a
 * downstream start file calls it with its own. SIGTERM and SIGINT stop it and end the process.
 */
export async function startServer({ modules = [] }: StartOptions = {}): Promise<Started> {
  const role = processRole() as "app" | "worker" | "mcp";
  process.env.SAIL_ROLE = role;
  const cfg = config();
  await loadModules(modules);

  let started: Started;
  if (role === "app") {
    const { assertIdentityConfigured } = await import("./auth/identity.js");
    assertIdentityConfigured();
    const { buildApp } = await import("./app.js");
    const app = buildApp();
    await startListener();
    const server = await new Promise<ReturnType<typeof serve>>((ok) => {
      const s = serve({ fetch: app.fetch, port: cfg.PORT }, (info) => {
        logger.info({ port: info.port }, "sail api listening");
        ok(s);
      });
    });
    started = {
      port: (server.address() as AddressInfo).port,
      stop: async () => {
        server.close();
        await stopListener();
        await closePool();
      },
    };
  } else if (role === "worker") {
    const { runWorker } = await import("./worker/index.js");
    const stop = await runWorker();
    started = {
      stop: async () => {
        await stop();
        await closePool();
      },
    };
  } else if (role === "mcp") {
    const { startMcpServer } = await import("./mcp/index.js");
    const mcp = await startMcpServer(cfg.PORT);
    started = {
      port: mcp.port,
      stop: async () => {
        await mcp.stop();
        await closePool();
      },
    };
  } else {
    throw new Error(`Unknown role ${role}`);
  }
  const removeHandlers = shutdown(started.stop);
  const stop = started.stop;
  return {
    ...started,
    stop: async () => {
      removeHandlers();
      await stop();
    },
  };
}

/** SIGTERM and SIGINT stop the role and end the process. Returns how to remove the handlers again (on stop). */
function shutdown(fn: () => Promise<void>): () => void {
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
  const onTerm = () => void handler("SIGTERM");
  const onInt = () => void handler("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  return () => {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
  };
}
