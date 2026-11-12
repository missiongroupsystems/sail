import type { RoundStage } from "@sail/ui";
import type { GuestLine, GuestOrder, GuestRound } from "./types";

/**
 * Where a round is (design 4.11): Sent → Accepted → Preparing → Done.
 * pending = Sent; accepted or fired = Accepted, and Preparing once the order
 * itself is fired; Done when the order is ready or completed; rejected shows
 * "Not accepted" with staff's reason.
 */
export function roundStage(round: Pick<GuestRound, "status">, order: Pick<GuestOrder, "status"> | null | undefined): RoundStage {
  if (round.status === "rejected") return "rejected";
  if (round.status === "pending") return "sent";
  if (order?.status === "ready" || order?.status === "completed") return "done";
  if (order?.status === "fired") return "preparing";
  return "accepted";
}

/** A word for each line on the "Our table" list (never colour alone, design 7.3). */
export function lineStatusLabel(line: Pick<GuestLine, "status">, order: Pick<GuestOrder, "status"> | null | undefined): string {
  switch (line.status) {
    case "held":
      return "Waiting for staff";
    case "pending":
      return "Accepted";
    case "fired":
      return order?.status === "ready" || order?.status === "completed" ? "Done" : "Preparing";
    case "voided":
      return "Removed";
  }
}

/** The register's status tone for a line, mapped to Sail's status tokens. */
export function lineStatusTone(line: Pick<GuestLine, "status">, order: Pick<GuestOrder, "status"> | null | undefined): "sent" | "paid" | "seated" | "ink-2" {
  if (line.status === "fired") return order?.status === "ready" || order?.status === "completed" ? "paid" : "sent";
  if (line.status === "pending") return "seated";
  return "ink-2";
}
