"use client";

import { create } from "zustand";

/** The three destinations plus the order screen (design 3.1). Client-side only: one long-lived page per station. */
export type Screen = { kind: "floor" } | { kind: "orders" } | { kind: "shift" } | { kind: "order"; orderId: string; from: "floor" | "orders" };

type NavState = {
  screen: Screen;
  go: (screen: Screen) => void;
  openOrder: (orderId: string, from?: "floor" | "orders") => void;
  back: () => void;
};

export const useNavStore = create<NavState>()((set, get) => ({
  screen: { kind: "floor" },
  go: (screen) => set({ screen }),
  openOrder: (orderId, from) => {
    const cur = get().screen;
    set({ screen: { kind: "order", orderId, from: from ?? (cur.kind === "orders" ? "orders" : cur.kind === "order" ? cur.from : "floor") } });
  },
  back: () => {
    const cur = get().screen;
    set({ screen: cur.kind === "order" ? { kind: cur.from } : { kind: "floor" } });
  },
}));
