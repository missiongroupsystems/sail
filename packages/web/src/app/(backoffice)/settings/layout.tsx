import { PageHeader } from "@sail/ui";
import type { ReactNode } from "react";
import { SettingsTabs } from "@/components/SettingsTabs";

export const metadata = { title: "Settings" };

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PageHeader title="Settings" description="Outlets, brands, stations and the merchant's tax and rounding rules." tabs={<SettingsTabs />} />
      {children}
    </>
  );
}
