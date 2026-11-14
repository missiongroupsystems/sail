import { PageHeader } from "@sail/ui";
import type { ReactNode } from "react";
import { SubNav } from "@/components/backoffice/SubNav";
import { REPORTS_TABS } from "@/lib/nav";
import { requireRole } from "@/lib/api.server";

export const metadata = { title: "Reports" };

/** Reports are a Manager's, as in the side rail: anyone below gets the same refusal page as Team and Audit. */
export default async function ReportsLayout({ children }: { children: ReactNode }) {
  await requireRole("manager");
  return (
    <>
      <PageHeader title="Reports" description="The Z-report, sales, items, shifts and print health, from the register's figures." tabs={<SubNav tabs={REPORTS_TABS} label="Report sections" />} />
      {children}
    </>
  );
}
