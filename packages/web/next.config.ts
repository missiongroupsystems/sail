import type { NextConfig } from "next";

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
  webpack: (webpackConfig) => {
    // @sail/shared imports its own modules as "./money.js" (ESM style, resolved by tsc to .ts);
    // webpack needs the same extension alias.
    webpackConfig.resolve ??= {};
    webpackConfig.resolve.extensionAlias = {
      ...webpackConfig.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return webpackConfig;
  },
};

export default config;
