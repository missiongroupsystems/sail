import { LinkButton, PageHeader } from "@sail/ui";
import type { ReactNode } from "react";
import { SubNav } from "@/components/backoffice/SubNav";
import { PRICING_TABS } from "@/lib/nav";

export const metadata = { title: "Pricing" };

export default function PricingLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PageHeader
        title="Pricing"
        tabs={<SubNav tabs={PRICING_TABS} label="Pricing sections" />}
        actions={
          <LinkButton href="/settings/merchant" variant="secondary">
            Tax &amp; rounding settings
          </LinkButton>
        }
      />
      {children}
    </>
  );
}
