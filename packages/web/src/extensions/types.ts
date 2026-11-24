import type { Role } from "@sail/shared";
import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";

/**
 * What a downstream build adds to the web app. The build sets SAIL_EXTENSIONS to a folder with two modules
 * (next.config.ts); stock Sail uses `none/`:
 * - `index`: its default export is `Extensions`. The whole app imports it, so it holds no pages.
 * - `pages`: its default export is `ExtensionPages`. Only the /x/ page imports it, so the pages reach no other bundle.
 */
export type Extensions = {
  /** Sections added to the rail after Sail's own, each linking to one of `pages` (`/x/hello`). */
  nav?: { href: string; label: string; icon: LucideIcon }[];
  /**
   * The pages below /x/ by path (`hello` serves /x/hello), with the lowest role that may open each. Anyone below gets
   * the refusal page, and the rail hides a section that links to it. A page listed here is served only when `pages`
   * has its component.
   */
  pages?: Record<string, { minRole?: Role }>;
  /** The product's name, and optionally its mark, in place of Sail's wherever the app shows them. */
  brand?: { name: string; mark?: ComponentType<{ size: number; className?: string }> };
};

/** The components of `Extensions.pages`, by the same paths. Client components. */
export type ExtensionPages = Record<string, ComponentType>;
