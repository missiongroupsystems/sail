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

describe("TagsField locked and empty (round 7)", () => {
  const input = (isDisabled: boolean) => renderToStaticMarkup(<TagsField label="Tags" value={[]} onChange={() => {}} isDisabled={isDisabled} />).match(/<input\b[^>]*>/)![0];
  it("asks for nothing and shows the not-allowed cursor over its input too", () => {
    const html = input(true);
    expect(html).not.toContain("Add a tag and press Enter");
    expect(html).toContain("cursor-not-allowed");
  });
  it("an editable empty field still says how to add a tag", () => {
    expect(input(false)).toContain('placeholder="Add a tag and press Enter"');
  });
});
