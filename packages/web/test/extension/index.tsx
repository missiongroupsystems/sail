import { Star } from "lucide-react";
import type { Extensions } from "../../src/extensions/types";

/** A downstream build's extensions, for the web unit tests and builds (SAIL_EXTENSIONS=test/extension). */
const extensions: Extensions = {
  nav: [
    { href: "/x/open", label: "Open", icon: Star },
    { href: "/x/managers", label: "Managers", icon: Star },
    // Found by its page despite the trailing slash and query.
    { href: "/x/admins/only/?tab=week", label: "Admins", icon: Star },
  ],
  pages: {
    open: { minRole: "server" },
    managers: { minRole: "manager" },
    "admins/only": { minRole: "admin" },
    // No rail section: reached by a link only, and still gated.
    "finance/only": { minRole: "finance" },
  },
  brand: { name: "Harbour", mark: ({ size }) => <svg width={size} height={size} /> },
};
export default extensions;
