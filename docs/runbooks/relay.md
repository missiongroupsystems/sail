# Runbook: print relay install, swap and failure handling

Status: v0.5, 4 Nov 2026. For Ops at each outlet. The relay is a small always-on device on the outlet LAN running the `sail-relay` Docker image. It needs outbound HTTPS only and talks to printers over TCP port 9100.

## Install a relay (about 10 minutes)

1. In the back office, open **Printing → Relays**, add a relay for the outlet (for example "Relay · Marina") and press **Pair**. A 6-digit code appears; it expires in 15 minutes.
2. On the device (Raspberry Pi 4 or any small Linux box with Docker):
   ```bash
   docker run -d --name sail-relay --restart unless-stopped \
     -v sail-relay-data:/data \
     -e SAIL_API_URL=https://<api-host> \
     -e SAIL_RELAY_PAIRING_CODE=<code> \
     -e SAIL_RELAY_VERSION=<image-tag> \
     <registry>/sail-relay:<image-tag>
   ```
   The relay pairs on first start and keeps its token in the `sail-relay-data` volume. Remove the `SAIL_RELAY_PAIRING_CODE` variable afterwards; it is single-use.
3. Check **Printing → Relays**: the relay shows **Online** with its version within a minute, and each printer shows reachable or not.
4. Press **Test print** on each printer. A ticket with "TEST PRINT" and the printer's IP prints.

## Printers

- Give every printer a fixed or reserved IP address on the outlet LAN. Set it in **Printing → Printers** with the port (9100), paper width, role (kitchen or receipt), include/exclude tags, copies and a **backup printer**. Mark one kitchen printer as the **default**: it receives items that match no other printer.
- Turn off **Supports status** for printers that do not answer the DLE EOT query (the relay then prints without checking paper and cover).

## Printer unplugged or out of paper mid-service

- Within 10 seconds every station in the outlet shows the banner "Kitchen printer not printing · N tickets waiting".
- Tap **Send to <backup> printer** to reroute the waiting tickets, or **Retry** to reprint on the same printer. Fix the printer (paper, cover, power, cable). New tickets route normally once the relay can reach it again.
- Nothing is lost: jobs stay queued on the server until they are printed or rerouted. Printed tickets carry their job ID.

## Relay restarted or offline

- A relay silent for 2 minutes shows **Offline** in the back office and stations show "Printing is offline at this outlet · check the print box is powered · N tickets waiting".
- Power-cycle the device. On reconnect the relay fetches every queued job and prints it; order is preserved. Duplicate tickets after a retry are possible and acceptable.

## Replace a relay with the spare (target: 15 minutes)

1. Back office → **Printing → Relays** → the outlet's relay → **Pair** (a new code). Pairing replaces the old token, so the dead device can no longer connect.
2. Start the spare with the new code (step 2 above). It downloads the printer list and prints the queue.
3. Keep the dead device for diagnosis; do not plug it back in without re-pairing.

## Update the relay image

- Images are pinned by tag. To roll out: pull the new tag and restart one outlet first, check **Online** and a test print, then the rest. To roll back: start the previous tag again. The token volume is untouched by updates.

## Diagnostics

- `docker logs -f sail-relay` prints JSON lines: `paired`, `printers loaded`, `stream connected`, `printed`, `print attempt failed` (with the printer's error), `heartbeat failed`.
- From the device, `nc -vz <printer-ip> 9100` checks reachability.
- The back office **Reports → Print health** (v0.9) lists failed, rerouted and reprinted jobs by printer and relay.
