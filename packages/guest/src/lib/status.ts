import type { RoundStage } from "@sail/ui";
import type { GuestLine, GuestOrder, GuestRound, OrderView } from "./types";

/**
 * Where a round is: Sent → Accepted → Preparing → Done.
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

/**
 * Whether to tell the guest how to pay. Not once the table's order is cancelled or completed, nor when this phone's
 * rounds are on no order any more (its only round was rejected and the order closed): nothing is owed. Before the phone
 * has sent anything, the line says how paying works.
 */
export function showsPayPrompt(view: Pick<OrderView, "order" | "rounds"> | null | undefined): boolean {
  if (view?.order) return view.order.status !== "cancelled" && view.order.status !== "completed";
  return (view?.rounds.length ?? 0) === 0;
}

/** A word for each line on the "Our table" list (never colour alone). */
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
