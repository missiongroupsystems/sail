"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Staff } from "../api/types";

type SessionState = {
  /** The PIN session token: memory plus sessionStorage, so a reload keeps the shift but a closed tab does not. */
  token: string | null;
  staff: Staff | null;
  /** Inactivity timeout from the register (design 4.1). */
  expiresInSeconds: number;
  /** Why the lock screen is showing, if a reason is worth saying ("Your session ended"). */
  lockNote: string | null;
  signIn: (token: string, staff: Staff, expiresInSeconds: number) => void;
  lock: (note?: string | null) => void;
};

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      token: null,
      staff: null,
      expiresInSeconds: 900,
      lockNote: null,
      signIn: (token, staff, expiresInSeconds) => set({ token, staff, expiresInSeconds, lockNote: null }),
      lock: (note = null) => set({ token: null, staff: null, lockNote: note }),
    }),
    { name: "sail.pos.session", storage: createJSONStorage(() => sessionStorage), version: 1, partialize: (s) => ({ token: s.token, staff: s.staff, expiresInSeconds: s.expiresInSeconds }) as SessionState },
  ),
);
