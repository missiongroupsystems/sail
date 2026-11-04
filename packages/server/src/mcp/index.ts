/** The MCP adapter arrives with the agent work; the role flag is reserved now. */
export async function startMcpServer(_port: number): Promise<() => Promise<void>> {
  throw new Error("The MCP server is not built yet in this phase");
}
