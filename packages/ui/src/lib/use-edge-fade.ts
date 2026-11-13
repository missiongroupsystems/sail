"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const FADE = {
  both: "[mask-image:linear-gradient(to_right,transparent,black_28px,black_calc(100%-28px),transparent)]",
  right: "[mask-image:linear-gradient(to_right,black_calc(100%-28px),transparent)]",
  left: "[mask-image:linear-gradient(to_right,transparent,black_28px)]",
  none: "",
} as const;
const FADE_Y = {
  both: "[mask-image:linear-gradient(to_bottom,transparent,black_24px,black_calc(100%-40px),transparent)]",
  right: "[mask-image:linear-gradient(to_bottom,black_calc(100%-40px),transparent)]",
  left: "[mask-image:linear-gradient(to_bottom,transparent,black_24px)]",
  none: "",
} as const;

/**
 * A strip that scrolls sideways (sub-tabs, a table on a phone): the edge fades where there is more beyond it, so the
 * person can tell there is more to see. `onScroll` goes on the scrolling element along with `ref`.
 */
export function useEdgeFade<T extends HTMLElement>(deps: unknown[] = [], axis: "x" | "y" = "x") {
  const ref = useRef<T>(null);
  const [edge, setEdge] = useState<keyof typeof FADE>("none");
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // On the y axis "left" is the top edge and "right" the bottom one.
    const left = axis === "x" ? el.scrollLeft > 1 : el.scrollTop > 1;
    const right = axis === "x" ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    setEdge(left && right ? "both" : right ? "right" : left ? "left" : "none");
  }, [axis]);
  useEffect(() => {
    measure();
    const el = ref.current;
    const observer = typeof ResizeObserver !== "undefined" && el ? new ResizeObserver(measure) : null;
    if (el) {
      observer?.observe(el);
      // The content growing (rows loading, a sheet's sections) changes what is beyond the edge too.
      for (const child of Array.from(el.children)) observer?.observe(child);
    }
    return () => observer?.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { ref, onScroll: measure, fadeClass: (axis === "x" ? FADE : FADE_Y)[edge] };
}
