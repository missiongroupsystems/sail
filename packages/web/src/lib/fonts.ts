import localFont from "next/font/local";

/*
 * Instrument Sans for text, Geist for headings and Geist Mono for codes, self-hosted from npm packages through
 * next/font/local, so a build never fetches a font and the browser never calls a font CDN. The variable names are
 * the ones the token layer reads (`--font-ui-body`, `--font-ui-headline`, `--font-ui-code` in @sail/ui/styles.css);
 * they go on <html>, where Tailwind's `@theme inline` font entries resolve. CJK falls back to the device's faces.
 */
export const sans = localFont({
  src: [
    { path: "../../node_modules/@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2", style: "normal" },
    { path: "../../node_modules/@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-italic.woff2", style: "italic" },
  ],
  variable: "--font-ui-body",
  weight: "400 700",
  display: "swap",
  fallback: ["-apple-system", "PingFang SC", "PingFang TC", "Hiragino Sans", "Noto Sans CJK SC", "system-ui", "sans-serif"],
});

export const headline = localFont({
  src: "../../node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2",
  variable: "--font-ui-headline",
  weight: "100 900",
  display: "swap",
  fallback: ["-apple-system", "system-ui", "sans-serif"],
});

export const mono = localFont({
  src: "../../node_modules/geist/dist/fonts/geist-mono/GeistMono-Variable.woff2",
  variable: "--font-ui-code",
  weight: "100 900",
  display: "swap",
  fallback: ["ui-monospace", "SF Mono", "Menlo", "monospace"],
});

/** Class names that define the three font variables; put them on <html>. */
export const fontClassNames = `${sans.variable} ${headline.variable} ${mono.variable}`;
