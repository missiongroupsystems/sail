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
        description="Fees and discounts, a simulator with the full trace, customer groups. Tax and rounding are merchant settings."
        tabs={<SubNav tabs={PRICING_TABS} label="Pricing sections" />}
        actions={
          <LinkButton href="/settings/merchant" variant="quiet">
            Tax &amp; rounding settings
          </LinkButton>
        }
      />
      {children}
    </>
  );
}
