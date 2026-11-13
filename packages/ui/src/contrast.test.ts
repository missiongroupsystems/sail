import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { accentText, contrastRatio, hexToRgb, onAccent, type Rgb } from "./lib/contrast";

/*
 * WCAG AA for every text-and-fill pair the components wear, in Day and in Service. The values are read from
 * styles.css itself, so the test cannot drift from the stylesheet. Text needs 4.5:1 (1.4.3); a control's boundary
 * or a mark that carries meaning needs 3:1 (1.4.11). Hairlines that only divide, disabled text and decoration are
 * exempt, as WCAG has them, and are not listed. A component that puts text on a new fill adds a pair here.
 */

const css = readFileSync(resolve(import.meta.dirname, "styles.css"), "utf8");

/** The custom properties declared in the first block that opens with `selector {`. */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`No ${selector} block in styles.css`);
  const body = css.slice(start, css.indexOf("\n}", start));
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars[m[1]!] = m[2]!.trim();
  return vars;
}

const DAY = block(":root");
const SERVICE = { ...DAY, ...block('[data-theme="service"]') };
const GUEST = { ...DAY, ...block('[data-surface="guest"]') };

type Rgba = Rgb & { a: number };

function parse(value: string, vars: Record<string, string>): Rgba {
  const v = value.trim();
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref) return parse(vars[ref[1]!] ?? "", vars);
  const rgb = hexToRgb(v);
  if (rgb) return { ...rgb, a: 1 };
  const rgba = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(v);
  if (rgba) return { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]), a: Number(rgba[4]) };
  throw new Error(`Cannot read colour "${value}"`);
}

/** A token as the eye sees it on `under`: alpha colours (the hairlines) are composited first. */
function seen(token: string, vars: Record<string, string>, under = "--surface"): Rgb {
  const c = parse(vars[token] ?? token, vars);
  if (c.a === 1) return c;
  const base = seen(under, vars);
  const mix = (x: number, y: number) => x * c.a + y * (1 - c.a);
  return { r: mix(c.r, base.r), g: mix(c.g, base.g), b: mix(c.b, base.b) };
}

type Pair = { fg: string; bg: string; bar: 4.5 | 3; where: string };

const PAIRS: Pair[] = [
  { fg: "--ink", bg: "--bg", bar: 4.5, where: "page text" },
  { fg: "--ink", bg: "--surface", bar: 4.5, where: "text on the sheet" },
  { fg: "--ink", bg: "--surface-2", bar: 4.5, where: "keys, quiet buttons, filled chips" },
  { fg: "--ink", bg: "--surface-3", bar: 4.5, where: "pressed keys, selected rows" },
  { fg: "--ink-2", bg: "--bg", bar: 4.5, where: "secondary text on the page" },
  { fg: "--ink-2", bg: "--surface", bar: 4.5, where: "secondary text" },
  { fg: "--ink-2", bg: "--surface-2", bar: 4.5, where: "secondary text on a fill (Badge neutral, rail)" },
  { fg: "--ink-2", bg: "--surface-3", bar: 4.5, where: "secondary text on a selected row" },
  { fg: "--ink-3", bg: "--surface", bar: 4.5, where: "hints, counts, placeholders" },
  { fg: "--ink-3", bg: "--surface-2", bar: 4.5, where: "placeholder in a filled field" },
  { fg: "--ink-3", bg: "--surface-3", bar: 4.5, where: "placeholder in a hovered or focused field" },
  { fg: "--ink-2", bg: "--status-alert-tint", bar: 4.5, where: "secondary text on an alert tint" },
  { fg: "--on-primary", bg: "--status-alert", bar: 4.5, where: "destructive button" },
  { fg: "--on-primary", bg: "--status-paid", bar: 4.5, where: "text on a paid fill" },
  { fg: "--on-primary", bg: "--primary", bar: 4.5, where: "primary button" },
  { fg: "--on-accent", bg: "--accent", bar: 4.5, where: "text on the green" },
  { fg: "--accent", bg: "--surface", bar: 4.5, where: "a link" },
  { fg: "--status-seated", bg: "--surface", bar: 4.5, where: "Seated" },
  { fg: "--status-sent", bg: "--surface", bar: 4.5, where: "Sent" },
  { fg: "--status-bill", bg: "--surface", bar: 4.5, where: "Bill asked" },
  { fg: "--status-paid", bg: "--surface", bar: 4.5, where: "Paid" },
  { fg: "--status-alert", bg: "--surface", bar: 4.5, where: "alerts and errors" },
  { fg: "--agent", bg: "--surface", bar: 4.5, where: "assistant text" },
  { fg: "--status-alert", bg: "--bg", bar: 4.5, where: "errors on the page" },
  { fg: "--status-seated", bg: "--status-seated-tint", bar: 4.5, where: "Seated badge" },
  { fg: "--status-sent", bg: "--status-sent-tint", bar: 4.5, where: "Sent badge" },
  { fg: "--status-bill", bg: "--status-bill-tint", bar: 4.5, where: "Bill badge" },
  { fg: "--status-paid", bg: "--status-paid-tint", bar: 4.5, where: "Paid badge" },
  { fg: "--status-alert", bg: "--status-alert-tint", bar: 4.5, where: "alert badge, inline error" },
  { fg: "--agent", bg: "--agent-tint", bar: 4.5, where: "assistant chip" },
  { fg: "--ink", bg: "--status-alert-tint", bar: 4.5, where: "inline error message" },
  { fg: "--focus", bg: "--surface", bar: 3, where: "focus ring on the sheet" },
  { fg: "--focus", bg: "--bg", bar: 3, where: "focus ring on the page" },
  { fg: "--primary", bg: "--surface", bar: 3, where: "switch on, checkbox ticked" },
  { fg: "--line-input", bg: "--surface", bar: 3, where: "checkbox box, empty PIN dot, neutral status dot" },
  { fg: "--line-input", bg: "--bg", bar: 3, where: "empty PIN dot on the page" },
  { fg: "--control-off", bg: "--surface", bar: 3, where: "switch off track" },
  { fg: "--line-input", bg: "--surface-2", bar: 3, where: "checkbox box on a fill" },
  { fg: "--status-seated", bg: "--bg", bar: 3, where: "status dot on the page" },
  { fg: "--status-sent", bg: "--bg", bar: 3, where: "status dot on the page" },
  { fg: "--status-bill", bg: "--bg", bar: 3, where: "status dot on the page" },
  { fg: "--status-paid", bg: "--bg", bar: 3, where: "status dot on the page" },
  { fg: "--status-alert", bg: "--bg", bar: 3, where: "status dot on the page" },
];

const THEMES = { Day: DAY, Service: SERVICE } as const;

describe("token contrast", () => {
  for (const [theme, vars] of Object.entries(THEMES)) {
    for (const p of PAIRS) {
      it(`${theme}: ${p.fg} on ${p.bg} (${p.where})`, () => {
        const ratio = contrastRatio(seen(p.fg, vars, p.bg), seen(p.bg, vars));
        expect(ratio, `${ratio.toFixed(2)}:1, needs ${p.bar}:1`).toBeGreaterThanOrEqual(p.bar);
      });
    }
  }

  it("Day and Service give every status a different hue, so tables stay distinguishable", () => {
    for (const vars of Object.values(THEMES)) {
      const hexes = ["--status-seated", "--status-sent", "--status-bill", "--status-paid", "--status-alert", "--agent"].map((t) => vars[t]);
      expect(new Set(hexes).size).toBe(hexes.length);
    }
  });

  it("guest: the default accent carries its label at 4.5:1 and reads as text on the sheet", () => {
    expect(contrastRatio(seen("--on-brand-accent", GUEST), seen("--brand-accent", GUEST))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(seen("--brand-accent", GUEST), seen("--surface", GUEST))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(seen("--brand-accent-text", GUEST), seen("--surface", GUEST))).toBeGreaterThanOrEqual(4.5);
    expect(accentText(GUEST["--brand-accent"]!)).toBe(GUEST["--brand-accent-text"]);
  });
});

describe("onAccent", () => {
  it("gives every accent a label colour at 4.5:1 or better", () => {
    // Every 17th step of each channel: 4,096 accents, light, dark and the mid tones where neither white nor ink is enough.
    for (let r = 0; r <= 255; r += 17)
      for (let g = 0; g <= 255; g += 17)
        for (let b = 0; b <= 255; b += 17) {
          const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
          const ratio = contrastRatio(hexToRgb(onAccent(hex))!, hexToRgb(hex)!);
          expect(ratio, `${onAccent(hex)} on ${hex}`).toBeGreaterThanOrEqual(4.5);
        }
  });

  it("keeps white on a dark accent and ink on a light one", () => {
    expect(onAccent("#173527")).toBe("#ffffff");
    expect(onAccent("#f5d90a")).toBe("#0d0d0d");
  });
});

describe("accentText", () => {
  it("gives every accent a text colour at 4.5:1 or better on the white guest sheet", () => {
    for (let r = 0; r <= 255; r += 17)
      for (let g = 0; g <= 255; g += 17)
        for (let b = 0; b <= 255; b += 17) {
          const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
          const ratio = contrastRatio(hexToRgb(accentText(hex))!, { r: 255, g: 255, b: 255 });
          expect(ratio, `${accentText(hex)} for ${hex}`).toBeGreaterThanOrEqual(4.5);
        }
  });

  it("keeps an accent that already reads and darkens one that does not", () => {
    expect(accentText("#173527")).toBe("#173527");
    expect(accentText("#f5d90a")).not.toBe("#f5d90a");
    expect(accentText("nope")).toBe("#173527");
  });
});

describe("keyboard focus", () => {
  it("restores the outline style outside every layer, so outline-none cannot hide a focus ring", () => {
    // Strip @layer and @theme blocks with their nested braces, leaving the unlayered rules.
    let unlayered = "";
    let depth = 0;
    let skipping = 0;
    for (let i = 0; i < css.length; i++) {
      const rest = css.slice(i);
      if (depth === 0 && /^@(layer|theme|utility|keyframes|source|import)/.test(rest)) skipping = 1;
      const ch = css[i]!;
      if (skipping && depth === 0 && ch === ";") {
        skipping = 0;
        continue;
      }
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0 && skipping) {
          skipping = 0;
          continue;
        }
      }
      if (!skipping) unlayered += ch;
    }
    expect(unlayered).toMatch(/\[data-focus-visible\],\s*:focus-visible\s*\{\s*--tw-outline-style:\s*solid;\s*\}/);
  });
});
