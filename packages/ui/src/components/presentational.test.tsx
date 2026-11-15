import { Users } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Eyebrow } from "./Eyebrow";
import { Hairline } from "./Hairline";
import { Pill } from "./Pill";
import { SectionHead } from "./SectionHead";
import { StatCard } from "./StatCard";

describe("presentational pieces", () => {
  it("a Pill carries its word and an icon, so status is never colour alone", () => {
    const html = renderToStaticMarkup(<Pill tone="seated" icon={Users}>Seated</Pill>);
    expect(html).toContain("Seated");
    expect(html).toContain("<svg");
    expect(html).toContain("bg-status-seated-tint");
  });

  it("a Hairline is a separator readers can skip, in both orientations", () => {
    expect(renderToStaticMarkup(<Hairline />)).toContain('role="separator"');
    expect(renderToStaticMarkup(<Hairline orientation="vertical" />)).toContain('aria-orientation="vertical"');
  });

  it("SectionHead renders a real heading at the level asked for", () => {
    const html = renderToStaticMarkup(<SectionHead as="h3" title="Open shifts" eyebrow="Kitchen" />);
    expect(html).toMatch(/<h3[^>]*>Open shifts<\/h3>/);
    expect(html).toContain("Kitchen");
  });

  it("StatCard shows the figure it is given and never computes one", () => {
    const html = renderToStaticMarkup(<StatCard label="Net sales" value="$1,204.50" caption="12 orders" />);
    expect(html).toContain("$1,204.50");
    expect(renderToStaticMarkup(<Eyebrow suffix="3">Waiting</Eyebrow>)).toContain("Waiting");
  });
});
