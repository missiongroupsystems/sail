"use client";

import { useEffect } from "react";

/**
 * Marks the page as the back office (`data-surface="office"` on <html>) while it is mounted, so sheets and dialogs,
 * which render outside the shell, draw back-office fields too. The POS never sets it.
 */
export function OfficeSurface() {
  useEffect(() => {
    document.documentElement.dataset.surface = "office";
    return () => {
      delete document.documentElement.dataset.surface;
    };
  }, []);
  return null;
}
