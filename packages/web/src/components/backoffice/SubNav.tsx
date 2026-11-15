"use client";

import { SectionTabs, type NavLinkProps, type SectionTab } from "@sail/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";

function NavLink({ href, children, ...rest }: NavLinkProps) {
  return (
    <Link href={href} {...rest}>
      {children}
    </Link>
  );
}

/** Tabs under a section header (Menu, Pricing, Settings), driven by the current path. */
export function SubNav({ tabs, label }: { tabs: readonly SectionTab[]; label: string }) {
  const pathname = usePathname();
  return <SectionTabs tabs={[...tabs]} currentPath={pathname} LinkComponent={NavLink} aria-label={label} />;
}
