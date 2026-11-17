"use client";

import { cx, Icon, initialsOf, Menu, MenuItem, MenuSeparator, MenuTrigger, sideNavLabelClass, sideNavRowClass, useHydrated } from "@sail/ui";
import { ChevronsUpDown, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import { browserRequests } from "@/lib/api.browser";
import { unsavedChanges } from "@/lib/unsaved";
import type { Me } from "@/lib/api/types";
import type { Theme } from "@/lib/cookies";

const ROLE_LABEL: Record<string, string> = { server: "Server", cashier: "Cashier", manager: "Manager", finance: "Finance", admin: "Admin" };

export function UserMenu({ me, theme: initialTheme }: { me: Me; theme: Theme }) {
  const router = useRouter();
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const name = me.name ?? "Signed in";
  const hydrated = useHydrated();

  const switchTheme = async () => {
    const next: Theme = theme === "day" ? "service" : "day";
    setTheme(next);
    if (next === "service") document.documentElement.dataset.theme = "service";
    else delete document.documentElement.dataset.theme;
    await fetch("/api/prefs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ theme: next }) });
  };

  const signOut = async () => {
    // A page with unsaved changes asks first; refused, nothing is stopped and the session stays.
    if (!unsavedChanges.confirmLeave()) return;
    // Stop the page's reads and refuse new ones first: a query still loading (Today's set-up checklist, say) would
    // otherwise reach the register after the session ended and be refused with a 401.
    await browserRequests.close();
    await fetch("/api/session", { method: "DELETE" });
    // A full load, not a client navigation: the closed client and the signed-out person's cached data go with the page.
    window.location.replace("/login");
  };

  return (
    <>
      {/* A real form, so a press before the page has hydrated still signs out: the browser posts it and the server ends
          the session (round 8 check 8). Once hydrated, the page does it itself, asking first about unsaved changes. */}
      <form
        method="post"
        action="/api/session/sign-out"
        onSubmit={(e) => {
          e.preventDefault();
          void signOut();
        }}
      >
        <button type="submit" aria-label="Sign out" className={cx(sideNavRowClass(), "cursor-default")}>
          <Icon icon={LogOut} size={16} />
          <span className={sideNavLabelClass()}>Sign out</span>
        </button>
      </form>
      <MenuTrigger>
      <AriaButton
        aria-label={`${name}, ${me.role ? ROLE_LABEL[me.role] ?? me.role : "staff"}. Open user menu`}
        // The menu needs the page's script: until it runs the button says it is not ready, rather than taking a press it drops.
        aria-disabled={hydrated ? undefined : true}
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
