import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The ui and shared packages export TypeScript source.
  transpilePackages: ["@sail/shared", "@sail/ui"],
  poweredByHeader: false,
};

export default config;
