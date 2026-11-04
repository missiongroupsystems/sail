"use client";

import { AttributionChip, Button, Icon, Menu, MenuItem, MenuSeparator, MenuTrigger } from "@sail/ui";
import { ChevronDown } from "lucide-react";
import { endSession } from "../api/register";
import { useApi } from "../hooks/useApi";
import { initialsOf, ROLE_LABEL } from "../lib/format";
import { useNavStore } from "../state/nav";
import { useSessionStore } from "../state/session";
import { useThemeStore } from "../state/ui";

/** Initials in the top bar (design 4.1): Switch user, theme, Sign out. */
export function UserMenu() {
  const api = useApi();
  const staff = useSessionStore((s) => s.staff);
  const lock = useSessionStore((s) => s.lock);
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);
  if (!staff) return null;

  const end = async (note: string | null, resetNav: boolean) => {
    try {
      await endSession(api);
    } catch {
      // The register may already have ended it; the station locks either way.
    }
    if (resetNav) useNavStore.getState().go({ kind: "floor" });
    lock(note);
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
      <Button variant="quiet" size="lg" aria-label={`${staff.name}, ${ROLE_LABEL[staff.role] ?? staff.role}. Open user menu`} className="gap-2 px-2">
        <AttributionChip who={{ kind: "person", initials: staff.initials ?? initialsOf(staff.name) }} />
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
