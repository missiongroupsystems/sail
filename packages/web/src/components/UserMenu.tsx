"use client";

import { cx, Icon, initialsOf, Menu, MenuItem, MenuSeparator, MenuTrigger, sideNavLabelClass, sideNavRowClass } from "@sail/ui";
import { ChevronsUpDown, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button as AriaButton } from "react-aria-components";
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
    <>
      <AriaButton onPress={() => void signOut()} aria-label="Sign out" className={cx(sideNavRowClass(), "cursor-default")}>
        <Icon icon={LogOut} size={16} />
        <span className={sideNavLabelClass()}>Sign out</span>
      </AriaButton>
      <MenuTrigger>
      <AriaButton
        aria-label={`${name}, ${me.role ? ROLE_LABEL[me.role] ?? me.role : "staff"}. Open user menu`}
        className={cx(sideNavRowClass(), "mt-1 cursor-default px-2")}
      >
        <span aria-hidden className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[11px] font-semibold text-ink">
          {me.initials ?? initialsOf(me.name)}
        </span>
        <span className={cx("flex min-w-0 flex-1 flex-col items-start leading-tight", sideNavLabelClass())}>
          <span className="max-w-full truncate text-[14px] text-ink">{name}</span>
          <span className="max-w-full truncate text-[12px] text-ink-3">{me.role ? ROLE_LABEL[me.role] ?? me.role : "Staff"}</span>
        </span>
        <Icon icon={ChevronsUpDown} size={14} className={cx("shrink-0 text-ink-3", sideNavLabelClass())} />
      </AriaButton>
      <Menu minWidth={240} placement="top start" onAction={(key) => (key === "theme" ? void switchTheme() : key === "password" ? router.push("/account/password") : key === "signout" ? void signOut() : undefined)}>
        <MenuItem id="theme" detail={theme === "day" ? "Day" : "Service"}>
          {theme === "day" ? "Switch to Service theme" : "Switch to Day theme"}
        </MenuItem>
        <MenuItem id="password">Change password</MenuItem>
        <MenuSeparator />
        <MenuItem id="signout">Sign out</MenuItem>
      </Menu>
      </MenuTrigger>
    </>
  );
}
