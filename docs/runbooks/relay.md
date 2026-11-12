# Print relay: install, replace and troubleshoot

The relay is a small always-on service on the outlet network, normally the `sail-relay` Docker image (`packages/relay/Dockerfile`). It needs outbound HTTPS to the API and reaches printers on TCP port 9100. How it works: [architecture.md](../architecture.md#printing-and-the-relay).

## Install

1. In the back office, open Printing > Relays, add a relay for the outlet and issue a pairing code. It is valid for 15 minutes.
2. On the device (any small Linux machine with Docker; the image is built for arm64 and amd64):
   ```bash
   docker run -d --name sail-relay --restart unless-stopped \
     -v sail-relay-data:/data \
     -e SAIL_API_URL=https://<api-host> \
     -e SAIL_RELAY_PAIRING_CODE=<code> \
     -e SAIL_RELAY_VERSION=<image-tag> \
     <registry>/sail-relay:<image-tag>
   ```
   Build the image with `docker buildx build --platform linux/arm64,linux/amd64 -f packages/relay/Dockerfile -t <registry>/sail-relay:<image-tag> .` from the repository root. The relay pairs on first start and keeps its token in the volume. Remove `SAIL_RELAY_PAIRING_CODE` afterwards; it is single-use.
3. Printing > Relays shows the relay online with its version within a minute.
4. Add each printer in Printing > Printers: a fixed or reserved IP address, port 9100, paper width, role (kitchen or receipt), include and exclude tags, copies and a backup printer. Mark one kitchen printer as the default; it receives items that match no other printer. Turn off status checks for printers that do not answer the DLE EOT query. Use Test print on each.

Without Docker: `pnpm --filter @sail/relay build`, then `SAIL_API_URL=... SAIL_RELAY_PAIRING_CODE=... node packages/relay/dist/index.js`, with `SAIL_RELAY_STATE_FILE` pointing at a file that survives restarts.

## A printer stops mid-service

Within 10 seconds every station at the outlet shows a banner with the number of tickets waiting. Staff can send them to the backup printer or retry on the same one. Jobs stay queued on the server until they print or are rerouted, so nothing is lost. A retry after a partial send can print a duplicate; each ticket carries its job id.

## The relay is offline

A relay that misses heartbeats shows as offline in the back office and on the stations. Restart the device. On reconnect the relay fetches every queued job and prints it in order.

## Replace a relay

Issue a new pairing code for the same relay and start the new device with it. Pairing again replaces the token, so the old device can no longer connect.

## Update

Images are pinned by tag. Pull the new tag and recreate the container at one outlet, check that it is online and that a test print works, then do the rest. To roll back, start the previous tag. The token volume survives updates.

## Diagnostics

- `docker logs -f sail-relay` prints JSON lines: `paired`, `printers loaded`, `stream connected`, `printed`, `print attempt failed` (with the printer's error), `heartbeat failed`.
- `nc -vz <printer-ip> 9100` from the device checks that a printer is reachable.
- Reports > Print health lists failed, rerouted and reprinted jobs by printer.
