import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FolderTile, Tile, tileHyphens } from "./Tile";
import { LocaleProvider } from "../lib/locale";

const settings = { currency: "USD", currencyExponent: 2, locale: "en-US", timeZone: "America/New_York" };
const tile = (props: Partial<Parameters<typeof Tile>[0]>) =>
  renderToStaticMarkup(
    <LocaleProvider settings={settings}>
      <Tile label="Garden salad" priceCents={950} colour="olive" onPress={() => undefined} {...props} />
    </LocaleProvider>,
  );

describe("Tile states (final review B-P11, round 8)", () => {
  it("a sold-out tile says so in place of the price, with nothing drawn over it", () => {
    const html = tile({ soldOut: true });
    expect(html).toContain("Sold out");
    expect(html).not.toContain("$9.50");
    expect(html).not.toContain("inset-0");
  });
  it("shows the count badge and the items left together, the left count in the alert colour when the order holds more", () => {
    const over = tile({ onOrder: 12, capRemaining: 5 });
    expect(over).toContain(">12</span>");
    expect(over).toMatch(/text-status-alert">· 5 left/);
    const under = tile({ onOrder: 2, capRemaining: 5 });
    expect(under).toContain(">2</span>");
    expect(under).toMatch(/text-status-sent">· 5 left/);
  });
  it("a folder of one says 1 item", () => {
    const html = renderToStaticMarkup(<FolderTile label="Hot" colour="teal" count={1} onPress={() => undefined} />);
    expect(html).toContain("1 item<");
    expect(html).toContain("with 1 item");
  });
});

describe("tileHyphens (final review B-P15)", () => {
  it("breaks between short words and hyphenates only a word too long for a line", () => {
    expect(tileHyphens("Garden salad")).toBe("hyphens-manual");
    expect(tileHyphens("Mee Goreng")).toBe("hyphens-manual");
    expect(tileHyphens("Supercalifragilistic")).toBe("hyphens-auto");
    expect(tileHyphens("Cheeseburger deluxe")).toBe("hyphens-auto");
  });
});
