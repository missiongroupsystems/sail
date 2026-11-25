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

  it("truncates the name only when told to fit, keeping the mark's size", () => {
    expect(renderToStaticMarkup(<SailLogo />)).not.toContain("truncate");
    const html = renderToStaticMarkup(<SailLogo fit name="Harbour" className="w-34" />);
    expect(html).toContain("min-w-0 truncate");
    expect(html).toContain('<span class="flex shrink-0"><svg');
  });

  it("names a fitted logo in a title, so a truncated name can be read", () => {
    expect(renderToStaticMarkup(<SailLogo fit name="Harbour Street Kitchen" className="w-34" />)).toMatch(/^<span role="img" aria-label="Harbour Street Kitchen" title="Harbour Street Kitchen"/);
    expect(renderToStaticMarkup(<SailLogo name="Harbour" />)).not.toContain("title=");
  });

  it("keeps Sail's own markup as it was, byte for byte", () => {
    const paths = '<path d="M2.5 13.5 L7.4 3.48 V13.5 Z" fill="currentColor"></path><path d="M8.6 3.48 L13.5 13.5 H8.6 Z" fill="currentColor"></path>';
    expect(renderToStaticMarkup(<SailLogo size="bar" />)).toBe(
      `<span role="img" aria-label="Sail" class="inline-flex shrink-0 items-center text-ink gap-2"><svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" class="shrink-0 text-ink text-current">${paths}</svg><span aria-hidden="true" class="font-heading font-semibold tracking-[-0.02em] text-[17px] leading-6">Sail</span></span>`,
    );
    expect(renderToStaticMarkup(<SailLogo size="card" />)).toBe(
      `<span role="img" aria-label="Sail" class="inline-flex shrink-0 items-center text-ink gap-2.5"><svg width="28" height="28" viewBox="0 0 16 16" aria-hidden="true" class="shrink-0 text-ink text-current">${paths}</svg><span aria-hidden="true" class="font-heading font-semibold tracking-[-0.02em] text-[22px] leading-7">Sail</span></span>`,
    );
  });

  it("draws the mark in currentColor, decorative unless named", () => {
    const html = renderToStaticMarkup(<SailMark size={32} />);
    expect(html).toContain('fill="currentColor"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("text-ink");
    expect(renderToStaticMarkup(<SailMark label="Sail" />)).toContain('aria-label="Sail"');
  });
});
