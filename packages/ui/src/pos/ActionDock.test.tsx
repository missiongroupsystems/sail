import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionDock } from "./ActionDock";
import { Pause, Percent, ReceiptText } from "lucide-react";

describe("ActionDock offline (final review B-P14)", () => {
  const html = renderToStaticMarkup(
    <ActionDock
      offline
      primary={{ id: "send", label: "Send 2", ariaLabel: "Send 2 to kitchen", onPress: () => undefined }}
      secondaries={[
        { id: "hold", label: "Hold", onPress: () => undefined },
        { id: "discount", label: "Discount", onPress: () => undefined },
        { id: "bill", label: "Bill", onPress: () => undefined, mutates: false },
      ]}
    />,
  );
  const button = (label: string) => html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*>${label}<`))?.[0] ?? "";
  it("keeps each control's own label", () => {
    expect(html).not.toContain(">Offline<");
    for (const l of ["Send 2", "Hold", "Discount", "Bill"]) expect(button(l), l).not.toBe("");
  });
  it("turns off exactly what needs the register", () => {
    for (const l of ["Send 2", "Hold", "Discount"]) expect(button(l), l).toMatch(/ disabled=""/);
    expect(button("Bill")).not.toMatch(/ disabled=""/);
  });
});

describe("ActionDock with three secondaries (final visual review 1)", () => {
  const html = renderToStaticMarkup(
    <ActionDock
      primary={{ id: "send", label: "Send 1", onPress: () => undefined }}
      secondaries={[
        { id: "hold", label: "Hold", icon: Pause, onPress: () => undefined },
        { id: "discount", label: "Discount", icon: Percent, onPress: () => undefined },
        { id: "bill", label: "Bill", icon: ReceiptText, onPress: () => undefined, mutates: false },
      ]}
    />,
  );
  it("keeps each name on screen at the order column's width and drops the icons instead", () => {
    for (const l of ["Hold", "Discount", "Bill"]) {
      const label = html.match(new RegExp(`<span class="([^"]*)">${l}</span>`))?.[1];
      expect(label, l).toBeDefined();
      expect(label!.split(" "), l).not.toContain("sr-only");
    }
    const icons = html.match(/<svg[^>]*class="[^"]*"/g) ?? [];
    expect(icons).toHaveLength(3);
    for (const i of icons) expect(i).toMatch(/\bhidden\b/);
  });
});
