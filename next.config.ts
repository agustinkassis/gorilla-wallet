import type { NextConfig } from "next";
import pkg from "./package.json";

const nextConfig: NextConfig = {
  // the desktop app (scripts/desktop.mjs) ships the self-contained server
  output: process.env.STANDALONE ? "standalone" : undefined,
  // shown on the desktop splash and in the sidebar footer
  env: { APP_VERSION: pkg.version },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
