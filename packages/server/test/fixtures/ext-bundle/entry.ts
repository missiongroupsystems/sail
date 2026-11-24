// A downstream start file at its smallest, for test/ext-bundle.test.ts: bundled into one file the way a production
// image is built (tsup with noExternal for @sail/server and @sail/shared), then run with node.
import { startServer } from "@sail/server";

await startServer();
