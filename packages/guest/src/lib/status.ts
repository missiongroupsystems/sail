import type { RoundStage } from "@sail/ui";
import type { GuestLine, GuestOrder, GuestRound, OrderView } from "./types";

/**
 * Where a round is: Sent → Accepted → Preparing → Done.
 * pending = Sent; accepted = Accepted, and Preparing once its items are sent to the kitchen; Done when the kitchen has
 * bumped every ticket of the round, at every station (the register's `kitchen_done`), or the order is ready or
 * completed; rejected shows "Not accepted" with staff's reason. Each round follows its own tickets, so a second round
 * still being made does not hold back the first.
 */
export function roundStage(round: Pick<GuestRound, "status"> & { kitchen_done?: boolean }, order: Pick<GuestOrder, "status"> | null | undefined): RoundStage {
  if (round.status === "rejected") return "rejected";
  if (round.status === "pending") return "sent";
  if (round.kitchen_done || order?.status === "ready" || order?.status === "completed") return "done";
  if (round.status === "fired" || order?.status === "fired") return "preparing";
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
export function lineStatusLabel(line: Pick<GuestLine, "status"> & { kitchen_done?: boolean }, order: Pick<GuestOrder, "status"> | null | undefined): string {
  switch (line.status) {
    case "held":
      return "Waiting for staff";
    case "pending":
      return "Accepted";
    case "fired":
      return line.kitchen_done || order?.status === "ready" || order?.status === "completed" ? "Done" : "Preparing";
    case "voided":
      return "Removed";
  }
}

/** The register's status tone for a line, mapped to Sail's status tokens. */
export function lineStatusTone(line: Pick<GuestLine, "status"> & { kitchen_done?: boolean }, order: Pick<GuestOrder, "status"> | null | undefined): "sent" | "paid" | "seated" | "ink-2" {
  if (line.status === "fired") return line.kitchen_done || order?.status === "ready" || order?.status === "completed" ? "paid" : "sent";
  if (line.status === "pending") return "seated";
  return "ink-2";
}

/**
 * The note under the prices: whether tax is in them (from the register's figures for the table, once it has an order)
 * and what the bill adds. Before anything is ordered the phone does not know the tax mode, so it says both cases
 * plainly (live-test D-4: diners were never told sales tax is added).
 */
export function billNote(taxMode: string | null | undefined): string {
  if (taxMode === "exclusive") return "Prices are before tax. Tax, service charge and any discounts are added to your bill.";
  if (taxMode === "inclusive") return "Prices include tax. Service charge and any discounts are added to your bill.";
  return "Prices are menu prices. Your bill adds service charge, any discounts and any tax not in these prices.";
}
