import { PageHeader } from "@sail/ui";
import type { ReactNode } from "react";
import { SubNav } from "@/components/backoffice/SubNav";
import { REPORTS_TABS } from "@/lib/nav";

export const metadata = { title: "Reports" };

export default function ReportsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PageHeader title="Reports" description="The Z-report, sales, items, shifts and print health, from the register's figures." tabs={<SubNav tabs={REPORTS_TABS} label="Report sections" />} />
      {children}
    </>
  );
}
