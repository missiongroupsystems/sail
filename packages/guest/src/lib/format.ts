/** "Water" stays "Water"; the register's `call_for_bill` reads as the bill request. */
export function requestLabel(type: string): string {
  return type === "call_for_bill" ? "Ask for the bill" : type;
}

/** "3 items" / "1 item". */
export function countItems(n: number): string {
  return `${n} ${n === 1 ? "item" : "items"}`;
}
