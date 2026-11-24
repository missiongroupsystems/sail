"use client";

import { OfficeSurface } from "./OfficeSurface";
import { Icon, SailMark, SideNav, sideNavLabelClass, sideNavRowClass, type NavLinkProps } from "@sail/ui";
import { Monitor } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import type { Brand, Me, Merchant, Outlet } from "@/lib/api/types";
import type { Scope, Theme } from "@/lib/cookies";
import { roleAtLeast } from "@sail/shared";
import { PRODUCT_MARK, PRODUCT_NAME } from "@/lib/brand";
import { RAIL } from "@/lib/nav";
import { ProductLogo } from "./ProductLogo";
import { ScopeControl } from "./ScopeControl";
import { ShownOutletProvider } from "./ShownOutlet";
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
  /** The scope came from a link's outlet of another brand; it is remembered as if chosen. */
  followed?: boolean;
  theme: Theme;
  children: ReactNode;
};

/** The product's logo at the top of the rail; the collapsed rail keeps only the mark (a downstream name without one: its initial). */
function Wordmark() {
  return (
    <>
      <ProductLogo size="sidebar" className="max-[1099px]:hidden" />
      <span className="flex h-6 justify-center min-[1100px]:hidden">
        {PRODUCT_MARK === undefined ? (
          <SailMark size={20} label="Sail" />
        ) : PRODUCT_MARK ? (
          <span role="img" aria-label={PRODUCT_NAME} className="text-ink">
            <PRODUCT_MARK size={20} />
          </span>
        ) : (
          <span role="img" aria-label={PRODUCT_NAME} className="font-heading text-[17px] leading-6 font-semibold text-ink">
            {PRODUCT_NAME.slice(0, 1)}
          </span>
        )}
      </span>
    </>
  );
}

/**
 * The back-office frame: a 240px rail on the sunken grey (wordmark, scope, sections, then Open the
 * POS and the user menu at its foot) beside a white content sheet. No top bar.
 */
export function Shell({ me, merchant, brands, outlets, scope, followed, theme, children }: ShellProps) {
  const pathname = usePathname();
  return (
    <ShownOutletProvider>
    <div data-scale="compact" className="flex min-h-dvh bg-surface text-body">
      <OfficeSurface />
      <aside className="sticky top-0 h-dvh shrink-0 print:hidden">
        <SideNav
          items={RAIL.filter((s) => !s.minRole || (me.role !== null && roleAtLeast(me.role, s.minRole)))}
          currentPath={pathname}
          LinkComponent={NavLink}
          header={
            <>
              <Wordmark />
              <ScopeControl merchantName={merchant.name} brands={brands} outlets={outlets} scope={scope} followed={followed} />
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
    </ShownOutletProvider>
  );
}
