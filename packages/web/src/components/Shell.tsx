"use client";

import { SideNav, type NavLinkProps } from "@sail/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import type { Brand, Me, Merchant, Outlet } from "@/lib/api/types";
import type { Scope, Theme } from "@/lib/cookies";
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

export function Shell({ me, merchant, brands, outlets, scope, theme, children }: ShellProps) {
  const pathname = usePathname();
  return (
    <div data-scale="compact" className="flex min-h-dvh text-body">
      <aside className="sticky top-0 h-dvh shrink-0">
        <SideNav
          items={SECTIONS}
          currentPath={pathname}
          LinkComponent={NavLink}
          header={<ScopeControl merchantName={merchant.name} brands={brands} outlets={outlets} scope={scope} />}
          footer={<span>Sail · back office</span>}
        />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-end gap-3 px-6 hairline-b">
          <UserMenu me={me} theme={theme} />
        </header>
        <main className="mx-auto w-full max-w-[1600px] flex-1 px-6 py-6">{children}</main>
      </div>
    </div>
  );
}
