import { Inbox } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Badge, KIND_TONE, kindTone } from "./Badge";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";
import { Select } from "./Select";
import { StatCard, StatTile, StatTiles } from "./StatCard";
import { TextField } from "./TextField";
import { DateField } from "./DateField";
import { sideNavRowClass } from "./SideNav";
import { LocaleProvider } from "../lib/locale";

describe("back-office sizes are opt-in", () => {
  it("Button keeps 44px by default and offers a 36px sm", () => {
    expect(renderToStaticMarkup(<Button>Save</Button>)).toContain("min-h-11");
    const sm = renderToStaticMarkup(<Button size="sm">Export</Button>);
    expect(sm).toContain("min-h-9");
    // 36px on a laptop, 44px at phone width (E-N14, F-N3): only the phone breakpoint raises it.
    expect(sm).toMatch(/max-sm:min-h-11/);
    expect(sm).not.toMatch(/(^|[\s"])min-h-11/);
    expect(renderToStaticMarkup(<Button size="lg">Send</Button>)).toContain("min-h-14");
  });

  it("TextField and Select keep 44px by default and offer a 36px filled sm", () => {
    const md = renderToStaticMarkup(<TextField label="Search" />);
    expect(md).toContain("min-h-11");
    const sm = renderToStaticMarkup(<TextField aria-label="Search" size="sm" />);
    expect(sm).toContain("min-h-9");
    expect(sm).toContain("bg-surface-2");
    expect(sm).not.toMatch(/(^|[\s"])min-h-11/);
    const items = [{ id: "a", label: "All brands" }];
    expect(renderToStaticMarkup(<Select aria-label="Brand" items={items} selectedKey="a" onSelectionChange={() => {}} />)).toContain("min-h-11");
    expect(renderToStaticMarkup(<Select aria-label="Brand" items={items} selectedKey="a" onSelectionChange={() => {}} size="sm" />)).toContain("min-h-9");
  });
});

describe("date fields at phone width (R sizes)", () => {
  it("the field and its Clear button are 44px tall under 640px", () => {
    const html = renderToStaticMarkup(
      <LocaleProvider settings={{ currency: "SGD", currencyExponent: 2, locale: "en-SG", timeZone: "Asia/Singapore" }}>
        <DateField aria-label="From" prefix="From" value="2026-11-14" onChange={() => {}} />
      </LocaleProvider>,
    );
    expect(html).toContain("max-sm:min-h-11");
    // The input covers the field's border too, so the tap area is the full 44px, not 42.
    expect(html).toContain("-inset-px");
    expect(html).toMatch(/aria-label="Clear From"[^>]*max-sm:size-11/);
  });
});

describe("the side rail at phone width (L4)", () => {
  it("every rail row, the footer's Sign out and user menu included, is 44px tall under 640px and 40px above", () => {
    for (const collapsed of ["auto", true, false] as const) {
      const row = sideNavRowClass(collapsed);
      expect(row).toMatch(/(^|\s)h-10(\s|$)/);
      expect(row).toMatch(/(^|\s)max-sm:h-11(\s|$)/);
    }
  });
});

describe("EmptyState centred", () => {
  it("centres an icon over one secondary sentence, and the panel variant draws the same (one empty state)", () => {
    const html = renderToStaticMarkup(<EmptyState variant="centred" icon={Inbox} title="Nothing waiting." />);
    expect(html).toContain("items-center");
    expect(html).toContain("text-center");
    expect(html).toContain("<svg");
    expect(html).toContain("Nothing waiting.");
    const panel = renderToStaticMarkup(<EmptyState title="No outlets yet" />);
    expect(panel).toContain("text-center");
    expect(panel).not.toContain("border-dashed");
    // Inside a Today panel too: centred with its icon, only with less room (compare2 office 8).
    const quiet = renderToStaticMarkup(<EmptyState variant="quiet" title="Nothing today" />);
    expect(quiet).toContain("text-center");
    expect(quiet).toContain("<svg");
  });
});

describe("StatCard is the one stat component", () => {
  it("is flat, steps its figure with the card's width, and is also StatTile", () => {
    const html = renderToStaticMarkup(<StatCard label="Net sales" value="$36.75" caption="2 orders" />);
    expect(html).not.toContain("shadow");
    expect(html).toContain("@container");
    expect(html).toContain("@[10rem]:text-[26px]");
    expect(html).toContain("$36.75");
    expect(StatTile).toBe(StatCard);
    expect(renderToStaticMarkup(<StatTiles columns={3}><StatTile label="Covers" value="4" /></StatTiles>)).toContain("@2xl:grid-cols-3");
  });
});

describe("pricing kind pills", () => {
  it("shows a fee as neutral and a discount in the paid tint", () => {
    expect(KIND_TONE).toEqual({ fee: "neutral", discount: "paid" });
    expect(kindTone("fee")).toBe("neutral");
    expect(kindTone("discount")).toBe("paid");
    expect(kindTone("surcharge")).toBe("neutral");
    expect(renderToStaticMarkup(<Badge tone={kindTone("discount")}>Discount</Badge>)).toContain("bg-status-paid-tint");
  });
});
