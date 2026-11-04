# Runbook: outage during service

Status: v0.9, 4 Nov 2026. For the outlet manager (first page) and Engineering (second page). Sail has no offline mode in v0.9 (scope doc 5), so the fallback is a paper procedure agreed with each outlet before go-live.

## 1. At the outlet: what you see and what to do

| What the POS shows | What it means | What to do |
|-|-|-|
| Grey "Reconnecting…" pill at the top; taps still work for a while | The station lost its live update stream; the API may still be reachable | Keep working. If taps start failing, see the next row. |
| "Can't reach Sail" banner; taps fail | The API or the internet link is down | Check the outlet router (lights, other devices). If the internet is up on a phone, the API is down: switch to **paper mode**. |
| "Printing is offline at this outlet · N tickets waiting" | The print relay is off or unplugged; the API is fine | See the relay runbook. Call orders to the kitchen by voice until it is back. Tickets print when it returns. |
| "Kitchen printer not printing · N tickets waiting" | One printer is down | Tap **Send to <backup>**. See the relay runbook. |
| The iPad shows the lock screen with "Station not paired" | The station token was revoked (an Admin re-paired or the iPad was replaced) | Pair again from the back office (Settings → Stations → Pair an iPad). |

**Paper mode** (API down for more than 5 minutes):
1. Write orders on numbered paper dockets (the pad is in the till drawer). Hand the kitchen copy through the pass.
2. Take payment: cash, and card on the terminal in standalone mode (the terminal prints its own receipt; staple a copy to the docket).
3. Give the guest the handwritten docket as a receipt; tell them a tax invoice can be emailed later from the docket number.
4. When Sail is back (the banner clears), key in every docket as a **takeaway** order named with the docket number, add the lines, fire with the kitchen told to ignore those tickets (or tap **Reprint** off), and record the payment with the terminal reference. Do this before the shift close so the Z-report and the terminal agree.
5. Tell Engineering how long you were down and how many dockets. They appear in the exception report as orders opened after the fact.

What does **not** happen: orders already sent are in the kitchen; payments already recorded are safe; nothing on the iPad is lost because the server holds every order.

## 2. Engineering: diagnosis and recovery

Alerting (blocked in v0.9 until the Fly and Supabase projects exist; see the completion note) is meant to page on: 5xx rate above 1% for 2 minutes, 503 admission rejections, SSE connection count dropping to zero at an outlet during its hours, late print jobs above 5 at an outlet, a relay with no heartbeat for 2 minutes.

1. **Is it us or the outlet?** `GET /health` from outside. Fly dashboard: machine state, recent deploys. If `/health` is fine and the outlet is down, it is their network: Ops calls the ISP; the outlet stays in paper mode.
2. **Database.** `/health` reports database connectivity. Supabase dashboard: connections, CPU, locks. A pooler restart drops the `LISTEN` connection; the API reconnects and emits `resync` to streams, so stations catch up by themselves.
3. **Admission gate.** 503s with `code: "overloaded"` mean TX_MAX is saturated: check for a slow query (pg_stat_activity), then scale machines or raise TX_MAX with DB_POOL_MAX. Streams are outside the gate.
4. **Bad release.** If the outage began within 30 minutes of a deploy, roll back first and diagnose later (release policy §3).
5. **Printing only.** Relay offline: Ops power-cycles; it fetches the queue on reconnect. Many late jobs with the relay online: a printer or the LAN; reroute to backups from the back office (Printing → Jobs → Reroute waiting).
6. **After recovery.** Tell the outlets to leave paper mode. Check the exception report for the window, and the next day's parallel-run reconciliation. Write the incident up (what, when, how long, what the outlet did, what we change) in `docs/incidents/`.

## 3. Numbers worth knowing

- SSE heartbeat every 25 s; a station treats 60 s of silence as disconnected and reconnects with backoff; it re-fetches events after its last sequence, so nothing is missed.
- Print jobs stay queued until printed or rerouted; a job not printed within 10 s is "late" and shows on every station at the outlet.
- A PIN session expires after 14 hours and locks after inactivity; an agent session after 15 minutes; a guest session after 4 hours or when the order closes.
