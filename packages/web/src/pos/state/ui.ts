"use client";

import { create } from "zustand";
import { useSessionStore } from "./session";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ConnectionStatus } from "@sail/ui";
import type { OverrideSubject, Role } from "../api/types";

/* ---- Theme: schedule from the outlet, or a manual choice -------- */

export type ThemeMode = "auto" | "day" | "service";

type ThemeState = { mode: ThemeMode; setMode: (mode: ThemeMode) => void };

export const useThemeStore = create<ThemeState>()(
  persist((set) => ({ mode: "auto", setMode: (mode) => set({ mode }) }), { name: "sail.pos.theme", storage: createJSONStorage(() => localStorage) }),
);

/* ---- Sound: off by default; a short tone for a new QR order or table request ---- */

type SoundState = { enabled: boolean; setEnabled: (on: boolean) => void };

export const useSoundStore = create<SoundState>()(persist((set) => ({ enabled: false, setEnabled: (enabled) => set({ enabled }) }), { name: "sail.pos.sound", storage: createJSONStorage(() => localStorage) }));

/* ---- Connection --------------------------------------------- */

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

/** `screen`: the Undo belongs to the screen it was made on (a line added or held) and goes when the person leaves it. */
export type UndoEntry = { id: number; label: string; undo: () => Promise<void> | void; screen?: boolean };
export type Notice = { id: number; text: string; remedy?: string | null; tone: "info" | "alert" | "success"; orderId?: string | null };

export type OverrideRequest = {
  subject: OverrideSubject;
  /** "Void Satay ×10", the verb and object. */
  title: string;
  /** The register's figures for the effect: "already sent · $18.00". */
  quote: string | null;
  /** The lowest role that may approve: the prompt names it, since a Cashier's PIN approves some actions. */
  minRole?: Role;
  resolve: (grant: { override_id: string; approverName: string } | null) => void;
};

type UiState = {
  undo: UndoEntry | null;
  notices: Notice[];
  /** Mutations in flight per order; the totals block shows "pricing" after 150 ms. */
  inFlight: Record<string, number>;
  activeSeat: Record<string, number | null>;
  override: OverrideRequest | null;
  showUndo: (label: string, undo: UndoEntry["undo"], opts?: { screen?: boolean }) => void;
  clearUndo: () => void;
  notify: (n: Omit<Notice, "id">, ttlMs?: number) => void;
  dismissNotice: (id: number) => void;
  beginMutation: (orderId: string) => void;
  endMutation: (orderId: string) => void;
  setActiveSeat: (orderId: string, seat: number | null) => void;
  requestOverride: (req: Omit<OverrideRequest, "resolve">) => Promise<{ override_id: string; approverName: string } | null>;
  settleOverride: (grant: { override_id: string; approverName: string } | null) => void;
  /** The station locked: nothing from the last person's session stays on screen for the next one. */
  clearForLock: () => void;
};

let seq = 0;

export const useUiStore = create<UiState>()((set, get) => ({
  undo: null,
  notices: [],
  inFlight: {},
  activeSeat: {},
  override: null,
  showUndo: (label, undo, opts) => set({ undo: { id: ++seq, label, undo, screen: opts?.screen } }),
  clearUndo: () => set({ undo: null }),
  notify: (n, ttlMs = 6000) => {
    // Locked, there is no one to tell: an action cut short by the lock (a 401 as the session ended) shows the PIN pad, not an error.
    if (!useSessionStore.getState().token) return;
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
  clearForLock: () => {
    const cur = get().override;
    set({ undo: null, notices: [], override: null });
    cur?.resolve(null);
  },
}));
