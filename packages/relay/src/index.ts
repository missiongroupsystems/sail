import { Relay } from "./relay.js";

/**
 * Sail print relay. Environment:
 *   SAIL_API_URL              the register, for example https://api.example.com
 *   SAIL_RELAY_STATE_FILE     where the relay token is kept (default /data/relay.json)
 *   SAIL_RELAY_PAIRING_CODE   6-digit code from the back office, for the first run only
 *   SAIL_RELAY_VERSION        reported in heartbeats (the image tag)
 */
const apiUrl = process.env.SAIL_API_URL;
if (!apiUrl) {
  console.error("SAIL_API_URL is required");
  process.exit(1);
}
const relay = new Relay({
  apiUrl: apiUrl.replace(/\/$/, ""),
  stateFile: process.env.SAIL_RELAY_STATE_FILE ?? "/data/relay.json",
  pairingCode: process.env.SAIL_RELAY_PAIRING_CODE,
  version: process.env.SAIL_RELAY_VERSION ?? "dev",
  log: (level, msg, extra) => console.log(JSON.stringify({ level, msg, time: new Date().toISOString(), ...extra })),
});

relay.start().catch((e) => {
  console.error(JSON.stringify({ level: "error", msg: "relay failed to start", error: (e as Error).message }));
  process.exit(1);
});
// Graceful stop: release unsent jobs and let in-flight sends finish (bounded), once, whichever signal arrives first.
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await relay.stop();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
