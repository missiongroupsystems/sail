"use client";

import { useLocale } from "@sail/ui";
import { useEffect } from "react";
import { useThemeStore, type ThemeMode } from "../state/ui";

/** Service ends in the small hours: a station still on at 3 am stays dim. */
const SERVICE_UNTIL = "05:00";

/** HH:MM in the outlet's zone; en-GB only fixes the 24-hour digits, nothing here is shown. */
function localHHMM(timeZone: string, d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).formatToParts(d);
  const h = parts.find((p) => p.type === "hour")?.value ?? "00";
  const m = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${h === "24" ? "00" : h}:${m}`;
}

/** Service theme by schedule: from the outlet's `service_theme_from` (default 18:00) until 05:00. */
export function scheduledTheme(serviceFrom: string | null | undefined, timeZone: string, now = new Date()): "day" | "service" {
  const from = serviceFrom && /^\d{2}:\d{2}$/.test(serviceFrom) ? serviceFrom : "18:00";
  const t = localHHMM(timeZone, now);
  return t >= from || t < SERVICE_UNTIL ? "service" : "day";
}

export function effectiveTheme(mode: ThemeMode, serviceFrom: string | null | undefined, timeZone: string): "day" | "service" {
  return mode === "auto" ? scheduledTheme(serviceFrom, timeZone) : mode;
}

function apply(theme: "day" | "service") {
  const root = document.documentElement;
  if (theme === "service") root.dataset.theme = "service";
  else delete root.dataset.theme;
}

/** Keeps `data-theme` on the root in step with the schedule and the manual toggle; re-checks every minute. */
export function useThemeScheduler(serviceFrom: string | null | undefined) {
  const mode = useThemeStore((s) => s.mode);
  const { timeZone } = useLocale();
  useEffect(() => {
    apply(effectiveTheme(mode, serviceFrom, timeZone));
    if (mode !== "auto") return;
    const t = setInterval(() => apply(effectiveTheme(mode, serviceFrom, timeZone)), 60_000);
    return () => clearInterval(t);
  }, [mode, serviceFrom, timeZone]);
}
