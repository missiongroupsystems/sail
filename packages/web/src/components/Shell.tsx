"use client";

import { OfficeSurface } from "./OfficeSurface";
import { Icon, SailLogo, SailMark, SideNav, sideNavLabelClass, sideNavRowClass, type NavLinkProps } from "@sail/ui";
import { Monitor } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import type { Brand, Me, Merchant, Outlet } from "@/lib/api/types";
import type { Scope, Theme } from "@/lib/cookies";
import { roleAtLeast } from "@sail/shared";
import { SECTIONS } from "@/lib/nav";
import { ScopeControl } from "./ScopeControl";
import { UserMenu } from "./UserMenu";

function NavLink({ href, children, ...rest }: NavLinkProps) {
  return (
    <Link href={href} {...rest}>
      {children}
    </Link>
  );
}

export type ShellProps = {
  me: Me;
  merchant: Merchant;
  brands: Brand[];
  outlets: Outlet[];
  scope: Scope;
  theme: Theme;
  children: ReactNode;
};

/** Sail's logo at the top of the rail; the collapsed rail keeps only the mark. */
function Wordmark() {
  return (
    <>
      <SailLogo size="sidebar" className="max-[1099px]:hidden" />
      <span className="flex h-6 justify-center min-[1100px]:hidden">
        <SailMark size={20} label="Sail" />
      </span>
    </>
  );
}

/**
 * The back-office frame: a 240px rail on the sunken grey (wordmark, scope, sections, then Open the
 * POS and the user menu at its foot) beside a white content sheet. No top bar.
 */
export function Shell({ me, merchant, brands, outlets, scope, theme, children }: ShellProps) {
  const pathname = usePathname();
  return (
    <div data-scale="compact" className="flex min-h-dvh bg-surface text-body">
      <OfficeSurface />
      <aside className="sticky top-0 h-dvh shrink-0">
        <SideNav
          items={SECTIONS.filter((s) => !s.minRole || (me.role !== null && roleAtLeast(me.role, s.minRole)))}
          currentPath={pathname}
          LinkComponent={NavLink}
          header={
            <>
              <Wordmark />
              <ScopeControl merchantName={merchant.name} brands={brands} outlets={outlets} scope={scope} />
            </>
          }
          footer={
            <>
              <Link href="/pos" title="Open the POS" className={sideNavRowClass()}>
                <Icon icon={Monitor} size={16} />
                <span className={sideNavLabelClass()}>Open the POS</span>
              </Link>
              <UserMenu me={me} theme={theme} />
            </>
          }
        />
      </aside>
      <main className="mx-auto w-full min-w-0 max-w-[1600px] flex-1 px-4 pt-7 pb-10 sm:px-8">{children}</main>
    </div>
  );
}
