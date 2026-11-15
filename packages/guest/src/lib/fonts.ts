import {
  Bricolage_Grotesque,
  Cormorant_Garamond,
  DM_Serif_Display,
  Fraunces,
  Josefin_Sans,
  Libre_Baskerville,
  Lora,
  Manrope,
  Outfit,
  Playfair_Display,
  Sora,
  Space_Grotesk,
} from "next/font/google";
import localFont from "next/font/local";

/*
 * Self-hosted through next/font. Each face only declares its
 * @font-face under a CSS variable; the browser downloads a face when a heading
 * uses it, so only the brand's chosen display font is fetched. Nothing is
 * preloaded except the UI family. CJK falls back to the device's system faces.
 * next/font needs every option written as a literal, hence the repetition.
 */
// The UI faces come from npm packages through next/font/local, so they are never fetched at build or run time:
// Instrument Sans for text, Geist for headings, Geist Mono for codes. The variable names are the token layer's.
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
export const headline = localFont({ src: "../../node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2", variable: "--font-ui-headline", weight: "100 900", display: "swap", fallback: ["-apple-system", "system-ui", "sans-serif"] });
export const mono = localFont({ src: "../../node_modules/geist/dist/fonts/geist-mono/GeistMono-Variable.woff2", variable: "--font-ui-code", weight: "100 900", display: "swap", fallback: ["ui-monospace", "SF Mono", "Menlo", "monospace"] });

// Keep in step with lib/display-fonts.ts (name -> variable).
const fraunces = Fraunces({ subsets: ["latin"], weight: ["500", "600"], variable: "--font-display-fraunces", display: "swap", preload: false, fallback: ["Georgia", "Times New Roman", "serif"] });
const playfair = Playfair_Display({ subsets: ["latin"], weight: ["500", "600"], variable: "--font-display-playfair", display: "swap", preload: false, fallback: ["Georgia", "Times New Roman", "serif"] });
const dmSerif = DM_Serif_Display({ subsets: ["latin"], weight: "400", variable: "--font-display-dm-serif", display: "swap", preload: false, fallback: ["Georgia", "Times New Roman", "serif"] });
const lora = Lora({ subsets: ["latin"], weight: ["500", "600"], variable: "--font-display-lora", display: "swap", preload: false, fallback: ["Georgia", "Times New Roman", "serif"] });
const cormorant = Cormorant_Garamond({ subsets: ["latin"], weight: ["500", "600"], variable: "--font-display-cormorant", display: "swap", preload: false, fallback: ["Georgia", "Times New Roman", "serif"] });
const libreBaskerville = Libre_Baskerville({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-display-libre-baskerville", display: "swap", preload: false, fallback: ["Georgia", "Times New Roman", "serif"] });
const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], weight: ["500", "600"], variable: "--font-display-space-grotesk", display: "swap", preload: false, fallback: ["-apple-system", "system-ui", "sans-serif"] });
const outfit = Outfit({ subsets: ["latin"], weight: ["500", "600"], variable: "--font-display-outfit", display: "swap", preload: false, fallback: ["-apple-system", "system-ui", "sans-serif"] });
const bricolage = Bricolage_Grotesque({ subsets: ["latin"], weight: ["500", "600"], variable: "--font-display-bricolage", display: "swap", preload: false, fallback: ["-apple-system", "system-ui", "sans-serif"] });
const josefin = Josefin_Sans({ subsets: ["latin"], weight: ["500", "600"], variable: "--font-display-josefin", display: "swap", preload: false, fallback: ["-apple-system", "system-ui", "sans-serif"] });
const manrope = Manrope({ subsets: ["latin"], weight: ["500", "600"], variable: "--font-display-manrope", display: "swap", preload: false, fallback: ["-apple-system", "system-ui", "sans-serif"] });
const sora = Sora({ subsets: ["latin"], weight: ["500", "600"], variable: "--font-display-sora", display: "swap", preload: false, fallback: ["-apple-system", "system-ui", "sans-serif"] });

/** Class names that define every font variable; put them on <html>. */
export const fontClassNames = [sans, headline, mono, fraunces, playfair, dmSerif, lora, cormorant, libreBaskerville, spaceGrotesk, outfit, bricolage, josefin, manrope, sora].map((f) => f.variable).join(" ");
