import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Select } from "./Select";

const brand = (props: { isRequired?: boolean; isInvalid?: boolean }) =>
  renderToStaticMarkup(<Select label="Brand" errorMessage="Choose a brand" items={[{ id: "a", label: "House" }]} selectedKey={null} onSelectionChange={() => {}} {...props} />);

const trigger = (html: string) => html.match(/<button\b[^>]*>/)![0];

/** What a screen reader takes as the trigger's name: the text of the elements it is labelled by, aria-hidden parts left out. */
function triggerName(html: string): string {
  const ids = trigger(html).match(/aria-labelledby="([^"]+)"/)![1]!.split(" ");
  return ids
    .map((id) => {
      const m = html.match(new RegExp(`<(\\w+)[^>]*\\bid="${id}"[^>]*>(.*?)</\\1>(?=<button|<svg|$|<span class|<div)`));
      return (m?.[2] ?? "").replace(/<span aria-hidden="true"[^>]*>[^<]*<\/span>/g, "").replace(/<[^>]+>/g, "");
    })
    .join(" ");
}

describe("Select", () => {
  it("a required Select is heard as required: its trigger's name carries the label's Required, which it shows the same", () => {
    const html = brand({ isRequired: true });
    expect(triggerName(html)).toContain("Required");
    expect(html).toContain(" · Required");
    expect(triggerName(brand({}))).not.toContain("Required");
  });

});
