"use client";

import { useEffect } from "react";

/**
 * Keeps a page's own state in its address (`?from=…&to=…`, `?order=…`) without a navigation, so a refresh keeps it
 * and the address can be shared. Empty values leave the query; other query values are kept.
 */
export function useUrlState(values: Record<string, string | null | undefined>) {
  const key = JSON.stringify(values);
  useEffect(() => {
    const url = new URL(window.location.href);
    for (const [name, value] of Object.entries(JSON.parse(key) as Record<string, string | null>)) {
      if (value) url.searchParams.set(name, value);
      else url.searchParams.delete(name);
    }
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url.href);
  }, [key]);
}
