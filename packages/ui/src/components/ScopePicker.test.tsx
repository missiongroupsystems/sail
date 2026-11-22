import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScopePicker, type ScopeOption } from "./ScopePicker";

/** The trigger's visible text and its accessible name, from the server render. */
function trigger(brands: ScopeOption[], outlets: ScopeOption[], value: { brandId: string | null; outletId: string | null }) {
  const html = renderToStaticMarkup(<ScopePicker merchantName="Twin Group" brands={brands} outlets={outlets} value={value} onChange={() => {}} />);
  const name = /aria-label="([^"]+)"/.exec(html)![1]!.replaceAll("&#x27;", "'");
  const text = /<span class="min-w-0[^"]*">([^<]*)<\/span>/.exec(html)![1]!;
  return { name, text };
}

const harbour = { id: "a", name: "Harbour Noodles" };
const quay = { id: "b", name: "Quay Coffee" };
const pier = { id: "a1", name: "Harbour Noodles · Pier", brandId: "a" };
const market = { id: "a2", name: "Harbour Noodles · Market", brandId: "a" };
const dock = { id: "b1", name: "Quay Coffee · Dock", brandId: "b" };

describe("ScopePicker trigger", () => {
  it("one brand with one outlet: just the brand", () => {
    expect(trigger([harbour], [pier], { brandId: "a", outletId: null })).toEqual({ text: "Harbour Noodles", name: "Scope: Twin Group ▸ Harbour Noodles ▸ All outlets" });
    expect(trigger([harbour], [pier], { brandId: "a", outletId: "a1" })).toEqual({ text: "Harbour Noodles", name: "Scope: Twin Group ▸ Harbour Noodles ▸ Harbour Noodles · Pier" });
  });
  it("one brand with several outlets: the outlet part", () => {
    expect(trigger([harbour, { id: "x", name: "Old", archived: true }], [pier, market], { brandId: "a", outletId: null }).text).toBe("All outlets");
    expect(trigger([harbour], [pier, market], { brandId: "a", outletId: "a2" })).toEqual({ text: "Market", name: "Scope: Twin Group ▸ Harbour Noodles ▸ Harbour Noodles · Market" });
  });
  it("several brands: the brand and the outlet's own name", () => {
    expect(trigger([harbour, quay], [pier, market, dock], { brandId: "b", outletId: "b1" })).toEqual({ text: "Quay Coffee · Dock", name: "Scope: Twin Group ▸ Quay Coffee ▸ Quay Coffee · Dock" });
    expect(trigger([harbour, quay], [pier, market, dock], { brandId: "a", outletId: null }).text).toBe("Harbour Noodles · All outlets");
  });
});
