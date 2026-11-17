import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SectionRail } from "./SectionRail";

describe("SectionRail inside a folder (round 8, 2)", () => {
  const html = renderToStaticMarkup(<SectionRail items={[{ id: "burgers", label: "Burgers" }, { id: "drinks", label: "Drinks" }]} selectedId="burgers" onSelect={() => undefined} folder={{ label: "S8 Seasonal specials for the autumn menu", onBack: () => undefined }} />);
  it("shows the folder's whole name, wrapping, as the current row", () => {
    expect(html).toContain("S8 Seasonal specials for the autumn menu");
    expect(html).toMatch(/aria-label="Back from S8[^"]*" aria-current="page"/);
    expect(html).not.toMatch(/truncate">S8/);
  });
  it("leaves the page behind it unhighlighted", () => {
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });
});
