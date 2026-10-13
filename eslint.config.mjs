import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src-tauri/**",
  ]),
  // Modules run sandboxed and talk to the wallet only through @/lib/modules/sdk (docs/MODULES.md).
  {
    files: ["modules/**"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["@/lib/server/*", "@/lib/generated/*", "@/lib/cli/*", "@/lib/api", "@/components/*", "!@/components/ui", "!@/components/ui/*", "**/lib/server/**", "server-only", "node:*", "fs", "child_process"],
          message: "Modules can't use the wallet's internals: go through @/lib/modules/sdk.",
        }],
      }],
    },
  },
]);

export default eslintConfig;
