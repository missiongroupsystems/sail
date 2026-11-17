import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef } from "pdf-lib";

/**
 * The strings a PDF draws, in order, as Unicode: each `Tj` decoded through the ToUnicode map of the font set by the
 * `Tf` before it. The documents embed a subset font (Identity-H, two-byte glyph codes), so the bytes alone say nothing.
 */
export async function pdfStrings(bytes: Uint8Array): Promise<string[]> {
  const pdf = await PDFDocument.load(bytes);
  const out: string[] = [];
  const raw = (s: unknown) => Buffer.from(decodePDFRawStream(s as PDFRawStream).decode()).toString("latin1");
  for (const page of pdf.getPages()) {
    const fonts = page.node.Resources()?.lookup(PDFName.of("Font"), PDFDict);
    const maps = new Map<string, Map<number, string>>();
    for (const [name, ref] of fonts?.entries() ?? []) {
      const dict = pdf.context.lookup(ref as PDFRef, PDFDict);
      const tu = dict.lookup(PDFName.of("ToUnicode"));
      const map = new Map<number, string>();
      if (tu) {
        const cmap = raw(tu);
        const hex = (h: string) => String.fromCodePoint(...(h.match(/.{4}/g) ?? []).map((x) => parseInt(x, 16)));
        for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(m[1]!, 16), hex(m[2]!));
        for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
          for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
            const [lo, hi, start] = [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
            for (let c = lo; c <= hi; c++) map.set(c, String.fromCodePoint(start + c - lo));
          }
      }
      maps.set(name.asString(), map);
    }
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map((r) => pdf.context.lookup(r)) : [contents];
    let current = new Map<number, string>();
    for (const s of streams) {
      for (const m of raw(s).matchAll(/(\/[\w.+-]+) [\d.]+ Tf|<([0-9A-Fa-f]*)> Tj/g)) {
        if (m[1]) current = maps.get(m[1]) ?? new Map();
        else out.push((m[2]!.match(/.{4}/g) ?? []).map((g) => current.get(parseInt(g, 16)) ?? "�").join(""));
      }
    }
  }
  return out;
}
