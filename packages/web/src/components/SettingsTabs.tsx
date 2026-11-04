"use client";

import { cx } from "@sail/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SETTINGS_TABS } from "@/lib/nav";

export function SettingsTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings sections" className="-mx-1 flex gap-1 overflow-x-auto">
      {SETTINGS_TABS.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "press flex min-h-11 items-center border-b-2 px-3 text-line no-underline outline-none",
              "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-status-seated",
              active ? "border-ink text-ink" : "border-transparent text-ink-2 hover:text-ink",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
