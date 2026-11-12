"use client";

import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { makeLocaleFormat, type LocaleFormat, type LocaleSettings } from "./locale-format";

const LocaleContext = createContext<LocaleFormat | null>(null);

/** One merchant's currency, locale and zone for everything under it. Also sets `<html lang>` to the merchant's locale. */
export function LocaleProvider({ settings, children }: { settings: LocaleSettings; children: ReactNode }) {
  const { currency, locale, timeZone } = settings;
  const value = useMemo(() => makeLocaleFormat({ currency, locale, timeZone }), [currency, locale, timeZone]);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/** The merchant's formatters. Throws outside a `LocaleProvider`, so a surface can never fall back to a hard-coded currency. */
export function useLocale(): LocaleFormat {
  const value = useContext(LocaleContext);
  if (!value) throw new Error("useLocale needs a LocaleProvider with the merchant's settings");
  return value;
}
