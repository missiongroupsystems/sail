"use client";

import { createContext, useContext, type ReactNode } from "react";

const Locked = createContext(false);

/**
 * Turns off every field inside it (text, select, switch, checkbox, date, money, percent, tags) for a role that may read
 * a record but not change it, so the form does not look editable while its Save is off (L3). Buttons that change the
 * form (Attach, Add, Remove) read `useFieldsLocked()` themselves; Cancel and Close stay usable.
 */
export function FieldsLocked({ locked, children }: { locked: boolean; children: ReactNode }) {
  const outer = useContext(Locked);
  return <Locked.Provider value={outer || locked}>{children}</Locked.Provider>;
}

/** True inside a locked `FieldsLocked`. */
export function useFieldsLocked(): boolean {
  return useContext(Locked);
}

/** A field's own `isDisabled`, or true when the fields around it are locked. */
export function useLockedDisabled(isDisabled: boolean | undefined): boolean | undefined {
  return useContext(Locked) || isDisabled;
}
