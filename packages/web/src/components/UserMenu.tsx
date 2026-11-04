"use client";

import { AttributionChip, Button, Icon, initialsOf, Menu, MenuItem, MenuSeparator, MenuTrigger } from "@sail/ui";
import { ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Me } from "@/lib/api/types";
import type { Theme } from "@/lib/cookies";

const ROLE_LABEL: Record<string, string> = { server: "Server", cashier: "Cashier", manager: "Manager", finance: "Finance", admin: "Admin" };

export function UserMenu({ me, theme: initialTheme }: { me: Me; theme: Theme }) {
  const router = useRouter();
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const name = me.name ?? "Signed in";

  const switchTheme = async () => {
    const next: Theme = theme === "day" ? "service" : "day";
    setTheme(next);
    if (next === "service") document.documentElement.dataset.theme = "service";
    else delete document.documentElement.dataset.theme;
    await fetch("/api/prefs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ theme: next }) });
  };

  const signOut = async () => {
    await fetch("/api/session", { method: "DELETE" });
    router.replace("/login");
    router.refresh();
  };

  return (
    <MenuTrigger>
      <Button variant="quiet" aria-label={`${name}, ${me.role ? ROLE_LABEL[me.role] ?? me.role : "staff"}. Open user menu`} className="-mr-2 gap-2 px-2">
        <AttributionChip who={{ kind: "person", initials: initialsOf(me.name) }} />
        <span className="hidden flex-col items-start leading-tight sm:flex">
          <span className="text-body text-ink">{name}</span>
          <span className="text-caption text-ink-2">{me.role ? ROLE_LABEL[me.role] ?? me.role : "Staff"}</span>
        </span>
        <Icon icon={ChevronDown} size={16} className="text-ink-2" />
      </Button>
      <Menu minWidth={240} onAction={(key) => (key === "theme" ? void switchTheme() : key === "signout" ? void signOut() : undefined)}>
        <MenuItem id="theme" detail={theme === "day" ? "Day" : "Service"}>
          {theme === "day" ? "Switch to Service theme" : "Switch to Day theme"}
        </MenuItem>
        <MenuSeparator />
        <MenuItem id="signout">Sign out</MenuItem>
      </Menu>
    </MenuTrigger>
  );
}
