// A downstream start file at its smallest, for test/ext-bundle.test.ts: bundled into one file the way a production
// image is built (tsup.config.ts here, the recipe in docs/extensions.md), then run with node.
import { startServer } from "@sail/server";

await startServer();
