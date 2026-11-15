import { LinkButton, PageHeader } from "@sail/ui";
import type { ReactNode } from "react";
import { SubNav } from "@/components/backoffice/SubNav";
import { MENU_TABS } from "@/lib/nav";

export const metadata = { title: "Menu" };

export default function MenuLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PageHeader
        title="Menu"
        description="Products, modifiers, menus and sections, availability and sold-out items."
        tabs={<SubNav tabs={MENU_TABS} label="Menu sections" />}
        actions={
          <LinkButton size="sm" href="/api/v1/exports/products.csv" download="products.csv">
            Export products CSV
          </LinkButton>
        }
      />
      {children}
    </>
  );
}
