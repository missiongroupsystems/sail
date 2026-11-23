"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Me, Merchant } from "./api/types";
import type { Scope } from "./cookies";

export type Session = {
  me: Me;
  merchant: Merchant;
  scope: Scope;
};

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ value, children }: { value: Session; children: ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** Who is signed in, their merchant, and the Brand ▸ Outlet scope. Server-rendered; the register is the source. */
export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside the back-office layout");
  return ctx;
}
