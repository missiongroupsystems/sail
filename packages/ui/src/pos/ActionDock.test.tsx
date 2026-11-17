import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionDock } from "./ActionDock";

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
