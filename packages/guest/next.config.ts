import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The ui package exports TypeScript source.
  transpilePackages: ["@sail/ui"],
  poweredByHeader: false,
};

export default config;
