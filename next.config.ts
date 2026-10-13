import type { NextConfig } from "next";
import pkg from "./package.json";

const dev = process.env.NODE_ENV === "development"

/**
 * Module frames (app/(module), /m/*): sandboxed even when opened outside the wallet's iframe (opaque origin: no
 * cookies, storage or same-origin API calls), and no network of their own: they reach the wallet, its server and the
 * hosts in their manifest only through the host frame (components/module-frame.tsx).
 * `next dev` won't serve its chunks to an opaque origin, so in dev each module gets its own origin instead,
 * <id>.localhost (the API refuses those hosts); /m/* on any other host stays sandboxed there too.
 */
const moduleCsp = (sandbox: boolean) =>
  [
    ...(sandbox ? ["sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"] : []),
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // dev: Next's hot reload socket; production: nothing
    `connect-src ${dev ? "'self' ws: wss:" : "'none'"}`,
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${dev ? "http://localhost:* http://127.0.0.1:*" : "'self'"}`,
  ].join("; ")
const moduleHost = [{ type: "host" as const, value: ".+\\.localhost" }]
const csp = (sandbox: boolean) => [{ key: "Content-Security-Policy", value: moduleCsp(sandbox) }]

const nextConfig: NextConfig = {
  async headers() {
    return dev
      ? [
          { source: "/m/:path*", has: moduleHost, headers: csp(false) },
          { source: "/m/:path*", missing: moduleHost, headers: csp(true) },
        ]
      : [{ source: "/m/:path*", headers: csp(true) }]
  },
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
