"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Station } from "@/pos/api/types";

type DisplayState = {
  /** The display station's token from pairing. Kept apart from the POS's, so one browser can be either. */
  token: string | null;
  station: Station | null;
  setPaired: (token: string, station: Station) => void;
  unpair: () => void;
};

export const useDisplayStore = create<DisplayState>()(
  persist(
    (set) => ({
      token: null,
      station: null,
      setPaired: (token, station) => set({ token, station }),
      unpair: () => set({ token: null, station: null }),
    }),
    { name: "sail.kds.station", storage: createJSONStorage(() => localStorage), version: 1 },
  ),
);
