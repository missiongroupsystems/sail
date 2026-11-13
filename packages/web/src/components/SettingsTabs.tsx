"use client";

import { SubNav } from "@/components/backoffice/SubNav";
import { SETTINGS_TABS } from "@/lib/nav";

/** The Settings sub-sections, drawn like every other section's tabs. */
export function SettingsTabs() {
  return <SubNav tabs={SETTINGS_TABS} label="Settings sections" />;
}
