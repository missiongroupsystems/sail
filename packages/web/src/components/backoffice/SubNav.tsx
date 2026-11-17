"use client";

import { roleAtLeast, type Role } from "@sail/shared";
import { SectionTabs, type NavLinkProps, type SectionTab } from "@sail/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "@/lib/session-context";

function NavLink({ href, children, ...rest }: NavLinkProps) {
  return (
    <Link href={href} {...rest}>
      {children}
    </Link>
  );
}

/** Tabs under a section header (Menu, Pricing, Settings), driven by the current path. A tab with `minRole` is left out for anyone below it. */
export function SubNav({ tabs, label }: { tabs: readonly (SectionTab & { minRole?: Role })[]; label: string }) {
  const pathname = usePathname();
  const { me } = useSession();
  const shown = tabs.filter((t) => !t.minRole || (me.role !== null && roleAtLeast(me.role as Role, t.minRole))).map(({ minRole: _minRole, ...t }) => t);
  return <SectionTabs tabs={shown} currentPath={pathname} LinkComponent={NavLink} aria-label={label} />;
}
