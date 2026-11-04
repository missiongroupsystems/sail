const clock = new Intl.DateTimeFormat("en-SG", { hour: "numeric", minute: "2-digit", hour12: true });

/** "8:31 pm" in the phone's own time zone (the guest is sitting in the room), design 6. */
export function formatClock(iso: string | Date): string {
  return clock.format(typeof iso === "string" ? new Date(iso) : iso).toLowerCase();
}

/** "Water" stays "Water"; the register's `call_for_bill` reads as the bill request. */
export function requestLabel(type: string): string {
  return type === "call_for_bill" ? "Ask for the bill" : type;
}

/** "3 items" / "1 item". */
export function countItems(n: number): string {
  return `${n} ${n === 1 ? "item" : "items"}`;
}
