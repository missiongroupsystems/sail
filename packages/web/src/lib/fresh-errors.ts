"use client";

import { useEffect, useRef } from "react";

type Resettable = { reset: () => void; isError: boolean; isIdle: boolean; isPending: boolean };

/**
 * A sheet stays mounted between uses, and so do its mutations: without this, a refusal from the register stays on screen
 * after the person fixes the field, after Cancel, and in the next record's sheet (live test E-N2). Opening, closing or
 * switching the sheet (`opened` changes) clears every mutation; editing the form (`values` changes) clears an error.
 */
export function useFreshErrors(opened: unknown, values: unknown, ...mutations: Resettable[]) {
  const all = useRef(mutations);
  all.current = mutations;
  useEffect(() => {
    for (const m of all.current) if (!m.isIdle && !m.isPending) m.reset();
  }, [opened]);
  const key = JSON.stringify(values ?? null);
  useEffect(() => {
    for (const m of all.current) if (m.isError) m.reset();
  }, [key]);
}
