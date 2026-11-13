import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * False while the page is server-rendered and during hydration, true once React runs in the browser. Lets a component
 * say it is not interactive yet, so a press on server-rendered markup before its handlers attach is not lost.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}
