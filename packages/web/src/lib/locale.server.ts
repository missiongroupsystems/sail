import { localeFromAcceptLanguage, localeSettings, type LocaleSettings, type LocaleSettingsSource } from "@sail/ui";
import { headers } from "next/headers";

/** The merchant's currency, locale and zone for server rendering. The locale falls back to the browser's, from the request, until the register has one. */
export async function merchantLocale(settings: LocaleSettingsSource): Promise<LocaleSettings> {
  const requestHeaders = await headers();
  return localeSettings(settings, localeFromAcceptLanguage(requestHeaders.get("accept-language")) ?? "en");
}
