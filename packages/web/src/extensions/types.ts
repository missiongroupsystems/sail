import type { Role } from "@sail/shared";
import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";

/**
 * What a downstream build adds to the back office. Sail imports `@sail/extensions`, which is `none.ts` unless the
 * build sets SAIL_EXTENSIONS to a module whose default export has this shape (next.config.ts). The module is
 * imported by client components, so its pages are client components.
 */
export type Extensions = {
  /** Sections added to the rail after Sail's own. Their pages are served under /x/. */
  nav?: { href: string; label: string; icon: LucideIcon; minRole?: Role }[];
  /** Pages by path below /x/: `{ hello: Hello }` serves /x/hello. */
  pages?: Record<string, ComponentType>;
  /** The product's name, in place of Sail's in the rail and the browser title. */
  brand?: { name: string };
};
