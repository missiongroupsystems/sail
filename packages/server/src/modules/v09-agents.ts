import { registerRoutes } from "../app.js";
import { registerWorkerTask } from "../worker/index.js";
import { agentRoutes } from "../routes/agents.js";
import { expireProposals } from "../services/agents.js";
import { withTransaction } from "../db/client.js";

/** v0.9: agent identities and sessions, risk ceilings, proposals (vision 7.2 to 7.4). The MCP adapter in `mcp/` drives these over the same API. */
registerRoutes(agentRoutes);

registerWorkerTask({
  name: "proposals.expire",
  intervalMs: 60_000,
  run: async () => {
    await withTransaction(() => expireProposals());
  },
});
