import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NowRail } from "./NowRail";

describe("NowRail QR lines (final review C-11)", () => {
  const html = renderToStaticMarkup(<NowRail items={[{ id: "r", title: "Table 5 · QR order", lines: [{ text: "1 Laksa · Prawn", note: "Nut allergy, please make sure nothing touches peanuts" }, { text: "1 Kopi", note: "Less sugar" }] }]} />);
  it("shows each note whole, under its line", () => {
    expect(html).toContain("Note: Nut allergy, please make sure nothing touches peanuts");
    expect(html).not.toContain("truncate");
  });
  it("emphasises the allergy note only", () => {
    expect(html).toMatch(/class="block font-semibold text-status-alert">Note: Nut allergy/);
    expect(html).toMatch(/class="block italic">Note: Less sugar/);
  });
});
