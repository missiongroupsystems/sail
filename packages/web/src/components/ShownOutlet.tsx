"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type Shown = { outletId: string | null; set: (id: string | null) => void };
const ShownOutletContext = createContext<Shown>({ outletId: null, set: () => {} });

/** Holds the outlet the current page works on, so the scope picker can name it while the scope covers all outlets. */
export function ShownOutletProvider({ children }: { children: ReactNode }) {
  const [outletId, set] = useState<string | null>(null);
  return <ShownOutletContext.Provider value={{ outletId, set }}>{children}</ShownOutletContext.Provider>;
}

/** The outlet the current page shows, or null on a page that covers all outlets. */
export function useShownOutlet() {
  return useContext(ShownOutletContext).outletId;
}

/** A per-outlet page says which outlet it shows; leaving the page clears it. */
export function useShowOutlet(outletId: string | null) {
  const { set } = useContext(ShownOutletContext);
  useEffect(() => {
    set(outletId);
    return () => set(null);
  }, [outletId, set]);
}
