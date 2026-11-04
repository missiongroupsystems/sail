import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Both workspace packages export TypeScript source.
  transpilePackages: ["@sail/shared", "@sail/ui"],
  poweredByHeader: false,
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
