import { PageHeader } from "@sail/ui";
import type { ReactNode } from "react";
import { SubNav } from "@/components/backoffice/SubNav";
import { PRINTING_TABS } from "@/lib/nav";

export const metadata = { title: "Printing" };

export default function PrintingLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PageHeader
        title="Printing"
        tabs={<SubNav tabs={PRINTING_TABS} label="Printing sections" />}
      />
      {children}
    </>
  );
}
