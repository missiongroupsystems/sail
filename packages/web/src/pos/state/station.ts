"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Station } from "../api/types";

type StationState = {
  /** The long-lived station token from pairing. Lives in localStorage: the iPad stays paired across reloads. */
  token: string | null;
  station: Station | null;
  deviceLabel: string | null;
  setPaired: (token: string, station: Station, deviceLabel: string) => void;
  updateStation: (station: Station) => void;
  unpair: () => void;
};

export const useStationStore = create<StationState>()(
  persist(
    (set) => ({
      token: null,
      station: null,
      deviceLabel: null,
      setPaired: (token, station, deviceLabel) => set({ token, station, deviceLabel }),
      updateStation: (station) => set({ station }),
      unpair: () => set({ token: null, station: null, deviceLabel: null }),
    }),
    { name: "sail.pos.station", storage: createJSONStorage(() => localStorage), version: 1 },
  ),
);
