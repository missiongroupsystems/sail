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
        description="Printers and their routing rules, the relay boxes that drive them, and every ticket the register has queued."
        tabs={<SubNav tabs={PRINTING_TABS} label="Printing sections" />}
      />
      {children}
    </>
  );
}
