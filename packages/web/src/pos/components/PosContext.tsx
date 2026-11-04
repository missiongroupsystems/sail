"use client";

import { createContext, useContext } from "react";
import type { CompiledMenu, FloorSnapshot, FloorTable, Layout, Outlet, Staff, Station } from "../api/types";

export type PosContextValue = {
  station: Station;
  staff: Staff;
  outlet: Outlet | null;
  menu: CompiledMenu | undefined;
  layout: Layout | undefined;
  floor: FloorSnapshot | undefined;
  tablesById: Map<string, FloorTable>;
  stationNames: Map<string, string>;
  /** The register cannot be reached: buttons that change things read "Offline" (design 7.8). */
  offline: boolean;
};

const Ctx = createContext<PosContextValue | null>(null);

export const PosProvider = Ctx.Provider;

/** The signed-in station's reference data, loaded once per shift (design 5.2: cached per channel link). */
export function usePos(): PosContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePos must be used inside the POS shell");
  return v;
}
