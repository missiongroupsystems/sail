"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ConnectionStatus } from "@sail/ui";

/* ---- Theme (design 7.3): schedule from the outlet, or a manual choice -------- */

export type ThemeMode = "auto" | "day" | "service";

type ThemeState = { mode: ThemeMode; setMode: (mode: ThemeMode) => void };

export const useThemeStore = create<ThemeState>()(
  persist((set) => ({ mode: "auto", setMode: (mode) => set({ mode }) }), { name: "sail.pos.theme", storage: createJSONStorage(() => localStorage) }),
);

/* ---- Connection (design 7.8) --------------------------------------------- */

type ConnectionState = {
  status: ConnectionStatus;
  /** Last moment the station heard from the register. */
  asOf: number | null;
  /** Shown for a few seconds after a reconnect: "Connected · caught up". */
  recoveredAt: number | null;
  set: (status: ConnectionStatus, asOf?: number | null) => void;
};

export const useConnectionStore = create<ConnectionState>()((set, get) => ({
  status: "online",
  asOf: null,
  recoveredAt: null,
  set: (status, asOf) => {
    const prev = get().status;
    set({ status, asOf: asOf === undefined ? get().asOf : asOf, recoveredAt: prev !== "online" && status === "online" ? Date.now() : status === "online" ? get().recoveredAt : null });
  },
}));

/* ---- Transient UI: undo, notices, pricing, override requests ---------------- */

export type UndoEntry = { id: number; label: string; undo: () => Promise<void> | void };
export type Notice = { id: number; text: string; remedy?: string | null; tone: "info" | "alert" | "success"; orderId?: string | null };

export type OverrideRequest = {
  action: "lines.void_fired" | "lines.add_open_price" | "adjustments.apply_manual" | "adjustments.remove";
  targetKind: "order" | "order_line";
  targetId: string;
  /** "Void Satay ×10", the verb and object. */
  title: string;
  /** The register's figures for the effect: "already sent · $18.00". */
  quote: string | null;
  resolve: (grant: { override_id: string; approverName: string } | null) => void;
};

type UiState = {
  undo: UndoEntry | null;
  notices: Notice[];
  /** Mutations in flight per order; the totals block shows "pricing" after 150 ms (design 7.8). */
  inFlight: Record<string, number>;
  activeSeat: Record<string, number | null>;
  override: OverrideRequest | null;
  showUndo: (label: string, undo: UndoEntry["undo"]) => void;
  clearUndo: () => void;
  notify: (n: Omit<Notice, "id">, ttlMs?: number) => void;
  dismissNotice: (id: number) => void;
  beginMutation: (orderId: string) => void;
  endMutation: (orderId: string) => void;
  setActiveSeat: (orderId: string, seat: number | null) => void;
  requestOverride: (req: Omit<OverrideRequest, "resolve">) => Promise<{ override_id: string; approverName: string } | null>;
  settleOverride: (grant: { override_id: string; approverName: string } | null) => void;
};

let seq = 0;

export const useUiStore = create<UiState>()((set, get) => ({
  undo: null,
  notices: [],
  inFlight: {},
  activeSeat: {},
  override: null,
  showUndo: (label, undo) => set({ undo: { id: ++seq, label, undo } }),
  clearUndo: () => set({ undo: null }),
  notify: (n, ttlMs = 6000) => {
    const id = ++seq;
    set({ notices: [...get().notices, { ...n, id }] });
    if (ttlMs > 0) setTimeout(() => get().dismissNotice(id), ttlMs);
  },
  dismissNotice: (id) => set({ notices: get().notices.filter((n) => n.id !== id) }),
  beginMutation: (orderId) => set({ inFlight: { ...get().inFlight, [orderId]: (get().inFlight[orderId] ?? 0) + 1 } }),
  endMutation: (orderId) => set({ inFlight: { ...get().inFlight, [orderId]: Math.max(0, (get().inFlight[orderId] ?? 0) - 1) } }),
  setActiveSeat: (orderId, seat) => set({ activeSeat: { ...get().activeSeat, [orderId]: seat } }),
  requestOverride: (req) =>
    new Promise((resolve) => {
      set({ override: { ...req, resolve } });
    }),
  settleOverride: (grant) => {
    const cur = get().override;
    set({ override: null });
    cur?.resolve(grant);
  },
}));
