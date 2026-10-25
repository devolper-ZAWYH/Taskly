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
    // Cloudflare / OpenNext build output:
    ".open-next/**",
    ".wrangler/**",
    "cloudflare-env.d.ts",
    // cPanel (Node.js) build output:
    "cpanel-build/**",
    // Claude's card page, built by scripts/build-cards.mjs:
    "server/mcp/cards/card-html.generated.ts",
    // The desktop recorder (Python) and its Tauri shell have their own tooling:
    "desktop-engine/**",
    "desktop-app/**",
  ]),
]);

export default eslintConfig;
