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

describe("LineRow notes and reasons are never cut off (final review C-11)", () => {
  const render = (props: { notes?: string; voidReason?: string; status?: "new" | "voided" }) =>
    renderToStaticMarkup(
      <LocaleProvider settings={settings}>
        <LineRow quantity={1} name="Laksa" amountCents={1600} status={props.status ?? "new"} notes={props.notes} voidReason={props.voidReason} />
      </LocaleProvider>,
    );
  const classOf = (html: string, text: string) => html.match(new RegExp(`class="([^"]*)"[^>]*>[^<]*${text}`))?.[1] ?? "";
  it("wraps a long note and a long reason instead of truncating them", () => {
    const html = render({ notes: "No peanuts at all please, my daughter is allergic", voidReason: "The kitchen has run out of fresh prawns for tonight's service", status: "voided" });
    expect(classOf(html, "No peanuts")).not.toContain("truncate");
    expect(classOf(html, "No peanuts")).toContain("break-words");
    expect(classOf(html, "Voided · The kitchen")).not.toContain("truncate");
  });
  it("gives an allergy note the quiet emphasis and leaves an ordinary note in italics", () => {
    expect(classOf(render({ notes: "Nut allergy" }), "Nut allergy")).toContain("text-status-alert");
    expect(classOf(render({ notes: "Less spicy" }), "Less spicy")).toContain("italic");
    expect(classOf(render({ notes: "Less spicy" }), "Less spicy")).not.toContain("text-status-alert");
  });
});
