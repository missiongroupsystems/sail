import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SailLogo, SailMark } from "./SailLogo";

describe("SailLogo", () => {
  it("is one image named Sail, with the word in the heading face", () => {
    const html = renderToStaticMarkup(<SailLogo />);
    expect(html).toMatch(/^<span role="img" aria-label="Sail"/);
    expect(html).toContain("font-heading");
    expect(html).toContain(">Sail</span>");
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(2);
  });

  it("scales the mark with its size variant", () => {
    expect(renderToStaticMarkup(<SailLogo size="bar" />)).toContain('width="18"');
    expect(renderToStaticMarkup(<SailLogo size="sidebar" />)).toContain('width="20"');
    expect(renderToStaticMarkup(<SailLogo size="card" />)).toContain('width="28"');
  });

  it("draws the mark in currentColor, decorative unless named", () => {
    const html = renderToStaticMarkup(<SailMark size={32} />);
    expect(html).toContain('fill="currentColor"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("text-ink");
    expect(renderToStaticMarkup(<SailMark label="Sail" />)).toContain('aria-label="Sail"');
  });
});
