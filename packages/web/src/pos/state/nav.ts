"use client";

import { create } from "zustand";

export type Origin = "floor" | "orders";

/**
 * The three destinations plus the order screen and the two screens that hang
 * off it, Bill and Pay (design 3.1, 4.4, 4.5). Client-side only: one long-lived
 * page per station.
 */
export type Screen =
  | { kind: "floor" }
  | { kind: "orders" }
  | { kind: "shift" }
  | { kind: "order"; orderId: string; from: Origin }
  | { kind: "bill"; orderId: string; from: Origin }
  | { kind: "pay"; orderId: string; checkId: string; from: Origin; returnTo: "order" | "bill" };

type NavState = {
  screen: Screen;
  go: (screen: Screen) => void;
  openOrder: (orderId: string, from?: Origin) => void;
  openBill: (orderId: string) => void;
  openPay: (orderId: string, checkId: string, returnTo?: "order" | "bill") => void;
  back: () => void;
};

const originOf = (s: Screen): Origin => (s.kind === "orders" ? "orders" : "from" in s ? s.from : "floor");

export const useNavStore = create<NavState>()((set, get) => ({
  screen: { kind: "floor" },
  go: (screen) => set({ screen }),
  openOrder: (orderId, from) => set({ screen: { kind: "order", orderId, from: from ?? originOf(get().screen) } }),
  openBill: (orderId) => set({ screen: { kind: "bill", orderId, from: originOf(get().screen) } }),
  openPay: (orderId, checkId, returnTo) => {
    const cur = get().screen;
    set({ screen: { kind: "pay", orderId, checkId, from: originOf(cur), returnTo: returnTo ?? (cur.kind === "bill" ? "bill" : "order") } });
  },
  back: () => {
    const cur = get().screen;
    if (cur.kind === "order") set({ screen: { kind: cur.from } });
    else if (cur.kind === "bill") set({ screen: { kind: "order", orderId: cur.orderId, from: cur.from } });
    else if (cur.kind === "pay") set({ screen: cur.returnTo === "bill" ? { kind: "bill", orderId: cur.orderId, from: cur.from } : { kind: "order", orderId: cur.orderId, from: cur.from } });
    else set({ screen: { kind: "floor" } });
  },
}));
