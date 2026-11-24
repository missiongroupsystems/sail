import { Star } from "lucide-react";
import type { Extensions } from "../../src/extensions/types";

/** A downstream build's extensions, for the web unit tests and builds (SAIL_EXTENSIONS=test/extension). */
const extensions: Extensions = {
  nav: [
    { href: "/x/open", label: "Open", icon: Star },
    { href: "/x/managers", label: "Managers", icon: Star },
  ],
  pages: {
    open: {},
    managers: { minRole: "manager" },
    // No rail section: reached by a link only, and still gated.
    "admins/only": { minRole: "admin" },
  },
  brand: { name: "Harbour", mark: ({ size }) => <svg width={size} height={size} /> },
};
export default extensions;
