import type { LocaleSettings } from "@sail/ui";

/** The merchant's currency, locale and zone (`GET /v1/merchant` → `data.settings`) for a `LocaleProvider`. */
export function merchantLocale(settings: { currency: string; currency_exponent: number; locale: string; timezone: string }): LocaleSettings {
  return { currency: settings.currency, currencyExponent: settings.currency_exponent, locale: settings.locale, timeZone: settings.timezone };
}
