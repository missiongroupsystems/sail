"use client";

import { Button, Icon, Menu, MenuItem, MenuSeparator, MenuTrigger } from "@sail/ui";
import { ChevronDown } from "lucide-react";
import { lockStation } from "../lib/lock";
import { useApi } from "../hooks/useApi";
import { ROLE_LABEL } from "../lib/format";
import { useNavStore } from "../state/nav";
import { useSessionStore } from "../state/session";
import { useThemeStore } from "../state/ui";

/** Name and role in the top bar: Switch user, theme, Sign out. */
export function UserMenu() {
  const api = useApi();
  const staff = useSessionStore((s) => s.staff);
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);
  if (!staff) return null;

  const end = async (note: string | null, resetNav: boolean) => {
    if (resetNav) useNavStore.getState().go({ kind: "floor" });
    await lockStation(api, note);
  };

  const onAction = (key: React.Key) => {
    switch (key) {
      case "switch":
        return void end("Switch user: the order stays open for you.", false);
      case "signout":
        return void end(null, true);
      case "theme-auto":
        return setMode("auto");
      case "theme-day":
        return setMode("day");
      case "theme-service":
        return setMode("service");
    }
  };

  return (
    <MenuTrigger>
      <Button variant="quiet" size="md" aria-label={`${staff.name}, ${ROLE_LABEL[staff.role] ?? staff.role}. Open user menu`} className="gap-1.5! pr-2! pl-3!">
        <span className="flex flex-col items-end leading-tight">
          <span className="text-[14px] font-medium text-ink">{staff.name}</span>
          <span className="text-[12px] font-normal text-ink-3">{ROLE_LABEL[staff.role] ?? staff.role}</span>
        </span>
        <Icon icon={ChevronDown} size={16} className="text-ink-2" />
      </Button>
      <Menu minWidth={260} onAction={onAction}>
        <MenuItem id="who" isDisabled detail={ROLE_LABEL[staff.role] ?? staff.role}>
          {staff.name}
        </MenuItem>
        <MenuSeparator />
        <MenuItem id="switch">Switch user</MenuItem>
        <MenuSeparator />
        <MenuItem id="theme-auto" detail={mode === "auto" ? "Selected" : undefined}>
          Theme by schedule
        </MenuItem>
        <MenuItem id="theme-day" detail={mode === "day" ? "Selected" : undefined}>
          Day theme
        </MenuItem>
        <MenuItem id="theme-service" detail={mode === "service" ? "Selected" : undefined}>
          Service theme
        </MenuItem>
        <MenuSeparator />
        <MenuItem id="signout">Sign out</MenuItem>
      </Menu>
    </MenuTrigger>
  );
}
