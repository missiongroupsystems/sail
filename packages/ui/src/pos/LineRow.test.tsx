import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LineRow } from "./LineRow";
import { LocaleProvider } from "../lib/locale";

const settings = { currency: "SGD", currencyExponent: 2, locale: "en-SG", timeZone: "Asia/Singapore" };
const row = (status: "voided" | "removed") =>
  renderToStaticMarkup(
    <LocaleProvider settings={settings}>
      <LineRow quantity={1} name="Iced tea" amountCents={299} status={status} voidReason="Kitchen error" />
    </LocaleProvider>,
  );

describe("LineRow void wording (M1)", () => {
  it("says Voided for a line taken off after it was sent", () => {
    expect(row("voided")).toContain("Voided · Kitchen error");
    expect(row("voided")).not.toContain("Removed");
  });
  it("says Removed for a line taken off before it was sent", () => {
    expect(row("removed")).toContain("Removed · Kitchen error");
    expect(row("removed")).not.toContain("Voided");
  });
});
