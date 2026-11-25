import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A downstream build's own folder (SAIL_EXTENSIONS, next.config.ts): Tailwind also generates the classes they use.
const extensions = process.env.SAIL_EXTENSIONS && resolve(dirname(fileURLToPath(import.meta.url)), process.env.SAIL_EXTENSIONS);

export default {
  plugins: {
    ...(extensions ? { "./scripts/postcss-extension-source.cjs": { dir: extensions } } : {}),
    "@tailwindcss/postcss": {},
  },
};
