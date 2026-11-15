import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bitmapToAscii, displayWidth, renderPrintJob, renderTextAsImageDefault, type PrintJobPayload } from "@sail/shared";
import { renderTextAsImageUnifont, shapeArabic, visualOrder } from "../src/lib/print-text.js";
import { bootWorld, orderHelpers, type Call, type World } from "./world.js";
import type { TestDb } from "./helpers.js";

/**
 * Text outside Latin-1 on a printer without a CJK code page is printed as a raster image (B3). These golden files are
 * the dots that go to the printer for each script the region presets need; they change only when the font or the
 * renderer does, and a reviewer can read them as ASCII art.
 */
const SAMPLES = {
  japanese: "味噌ラーメン 大盛り",
  chinese: "宫保鸡丁 小份",
  korean: "김치찌개",
  arabic: "شاورما دجاج ×2",
  accented: "Żurek, Česnečka, Ξηρά, Борщ",
} as const;

const draw = (text: string, render = renderTextAsImageUnifont) => {
  const bitmap = render(text, 576, { align: "left", width: 1, height: 1 });
  return bitmapToAscii(bitmap)
    .split("\n")
    .map((row) => row.slice(0, displayWidth(text) * 12).replace(/\.+$/, ""))
    .join("\n");
};

describe("raster text for scripts outside Latin-1", () => {
  for (const [name, text] of Object.entries(SAMPLES)) {
    it(`${name}: matches its golden file and is not the placeholder boxes`, async () => {
      const art = draw(text);
      await expect(art + "\n").toMatchFileSnapshot(`golden/print-${name}.txt`);
      expect(art).not.toBe(draw(text, renderTextAsImageDefault));
    });
  }

  it("Arabic letters join, and an Arabic run reads right to left inside a left-to-right line, numbers kept in order", () => {
    const cps = (s: string) => [...s].map((c) => c.codePointAt(0)!);
    // ب ا ب: initial beh, final alef (alef never joins forwards), isolated beh.
    expect(shapeArabic(cps("باب"))).toEqual([0xfe91, 0xfe8e, 0xfe8f]);
    // lam + alef is one ligature.
    expect(shapeArabic(cps("لا"))).toEqual([0xfefb]);
    expect(visualOrder(cps("2x دجاج 12"))).toEqual(cps("2x جاجد 12"));
    expect(visualOrder(cps("دجاج 12 كبير"))).toEqual(cps("ريبك 12 جاجد"));
  });
});

describe("print jobs use the bundled font", () => {
  let db: TestDb;
  let call: Call;
  let w: World;
  beforeAll(async () => {
    ({ db, call, w } = await bootWorld());
  }, 120_000);
  afterAll(async () => db.drop());

  it("a kitchen ticket with a Japanese item is rasterised with the font, not placeholder boxes", async () => {
    const id = w.ids.laksa;
    expect((await call("PATCH", `/v1/products/${id}`, { token: w.m.admin.token, body: { name: SAMPLES.japanese } })).status).toBe(200);
    const h = orderHelpers(call, w);
    const s = await h.orderWith(w.pins.server, [{ product_id: id }]);
    expect((await h.fire(w.pins.server, s.id)).status).toBe(200);
    const [job] = await db.sql<{ payload: string; document: PrintJobPayload }[]>`select payload, document from print_jobs where order_id = ${s.id} and kind = 'kitchen'`;
    const profile = { width: "80mm" as const, code_page_cjk: false, cut: true, beep: false };
    const bytes = Buffer.from(job!.payload, "base64");
    expect(bytes.equals(Buffer.from(renderPrintJob(job!.document, profile, { renderTextAsImage: renderTextAsImageUnifont }).bytes))).toBe(true);
    expect(bytes.equals(Buffer.from(renderPrintJob(job!.document, profile).bytes))).toBe(false);
  });
});
