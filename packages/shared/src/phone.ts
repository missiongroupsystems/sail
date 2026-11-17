/**
 * Mobile numbers in E.164 ("+15555550123"). A number is stored as the register normalised it: a leading "+" or "00"
 * keeps its own country code, a national number (with or without its trunk 0) takes the merchant's country, read
 * from the region of its locale ("en-US" → +1). Searches match any 3 or more digits of the number, with or without
 * the "+", spaces or the country code.
 */
export const CALLING_CODES: Record<string, string> = {
  US: "1", CA: "1", GB: "44", IE: "353", SG: "65", MY: "60", ID: "62", TH: "66", PH: "63", VN: "84", HK: "852", TW: "886", JP: "81", KR: "82", CN: "86", IN: "91",
  AU: "61", NZ: "64", AE: "971", SA: "966", KW: "965", QA: "974", DE: "49", AT: "43", CH: "41", FR: "33", BE: "32", NL: "31", LU: "352", ES: "34", PT: "351", IT: "39",
  SE: "46", NO: "47", DK: "45", FI: "358", PL: "48", CZ: "420", GR: "30", ZA: "27", MX: "52", BR: "55",
};

/** The calling code of a locale's region ("en-US" → "1"), or null when the locale names no known region. */
export function callingCodeFor(locale: string | null | undefined): string | null {
  const region = locale?.split(/[-_]/).find((p, i) => i > 0 && /^[A-Za-z]{2}$/.test(p))?.toUpperCase();
  return region ? (CALLING_CODES[region] ?? null) : null;
}

/** Normalise a typed mobile to E.164 with the merchant's locale as the default country. Returns the digits as typed when no country is known. */
export function toE164(raw: string, locale: string | null | undefined): string {
  const t = raw.trim();
  const digits = t.replace(/\D/g, "");
  if (!digits) return t;
  if (t.startsWith("+")) return `+${digits}`;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  const cc = callingCodeFor(locale);
  if (!cc) return digits;
  // A national number: drop its trunk 0 (not used in NANP numbers), then add the country code. A number typed with
  // the country code but no "+" (11 digits starting 1 in the US) keeps it rather than doubling it.
  if (cc === "1") return digits.length === 11 && digits.startsWith("1") ? `+${digits}` : `+1${digits}`;
  return `+${cc}${digits.replace(/^0/, "")}`;
}

/** The digits a search compares: what was typed, and the same without the merchant's country code or trunk 0. */
export function phoneSearchDigits(raw: string, locale: string | null | undefined): string[] {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 3) return [];
  const cc = callingCodeFor(locale);
  const out = new Set([digits]);
  if (cc && digits.startsWith(cc) && digits.length > cc.length + 2) out.add(digits.slice(cc.length));
  if (digits.startsWith("0") && digits.length > 3) out.add(digits.slice(1));
  return [...out];
}
