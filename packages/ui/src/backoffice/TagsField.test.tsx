import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TagsField } from "./TagsField";

const chip = (isDisabled: boolean) => {
  const html = renderToStaticMarkup(<TagsField label="Notes and coins" value={["$5.00"]} onChange={() => {}} isDisabled={isDisabled} />);
  const remove = html.match(/<button\b[^>]*aria-label="Remove \$5\.00"[^>]*>/)![0];
  const tag = html.match(/<span\b[^>]*>\$5\.00/)![0];
  return { remove, tag };
};

describe("TagsField locked chips (M6)", () => {
  it("a locked chip and its × look off, in the disabled ink of other controls", () => {
    const { remove, tag } = chip(true);
    expect(remove).toMatch(/\sdisabled=""/);
    expect(remove).toContain("text-ink-disabled");
    expect(remove).toContain("cursor-not-allowed");
    expect(tag).toContain("text-ink-disabled");
  });
  it("a live chip keeps its normal ink", () => {
    const { remove, tag } = chip(false);
    expect(remove).not.toMatch(/\sdisabled=""/);
    expect(remove).not.toMatch(/(^|\s)text-ink-disabled/);
    expect(tag).not.toContain("text-ink-disabled");
  });
});
