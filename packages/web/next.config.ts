import type { NextConfig } from "next";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A downstream build points SAIL_EXTENSIONS at its own folder (src/extensions/types.ts), relative to this folder or
// absolute; stock Sail adds nothing. postcss.config.mjs reads the same setting.
const extensions = resolve(dirname(fileURLToPath(import.meta.url)), process.env.SAIL_EXTENSIONS || "src/extensions/none");
// The modules are swapped by a webpack plugin (below), which Turbopack does not run: it would build stock Sail.
if (process.env.SAIL_EXTENSIONS && process.env.TURBOPACK) throw new Error("SAIL_EXTENSIONS needs the webpack build: run next without --turbopack");

const config: NextConfig = {
  reactStrictMode: true,
  // Both workspace packages export TypeScript source.
  transpilePackages: ["@sail/shared", "@sail/ui"],
  poweredByHeader: false,
  // forbidden(): a page the person's role may not read shows a refusal (app/(backoffice)/forbidden.tsx), not a 500.
  experimental: { authInterrupts: true },
  // The end-to-end run starts a second back office for first-run setup; it builds into its own directory.
  distDir: process.env.SAIL_WEB_DIST_DIR || ".next",
  // Development server only: keep every compiled page for an hour instead of the last five for a minute. A walk through
  // the back office's ~30 pages otherwise recompiled each page on every visit, which made each visit take seconds and
  // grew the server past 8 GB until it was killed (the end-to-end run's role walks, CI).
  onDemandEntries: { maxInactiveAge: 60 * 60 * 1000, pagesBufferLength: 100 },
  webpack: (webpackConfig, { webpack }) => {
    // @sail/shared imports its own modules as "./money.js" (ESM style, resolved by tsc to .ts);
    // webpack needs the same extension alias.
    webpackConfig.resolve ??= {};
    webpackConfig.resolve.extensionAlias = {
      ...webpackConfig.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    // Replaced before resolution: tsconfig's path for @sail/extensions (stock) would win over a resolve alias.
    webpackConfig.plugins.push(new webpack.NormalModuleReplacementPlugin(/^@sail\/extensions$/, `${extensions}/index`));
    webpackConfig.plugins.push(new webpack.NormalModuleReplacementPlugin(/^@sail\/extensions\/pages$/, `${extensions}/pages`));
    return webpackConfig;
  },
};

export default config;
