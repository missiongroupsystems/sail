import { logger } from "./logger.js";
import { startServer } from "./start.js";

/**
 * One image, role flags: `node dist/index.js --role=app|worker|mcp`.
 */
startServer().catch((e) => {
  logger.fatal({ err: e }, "fatal");
  process.exit(1);
});
