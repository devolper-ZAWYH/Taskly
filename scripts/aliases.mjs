/**
 * Module-resolution hooks for `node --test` (loaded via scripts/test-aliases.mjs):
 * they spell out the `@/*` tsconfig path map, which plain Node doesn't read.
 * Source files keep importing via `@/` (Next and tsc resolve it natively);
 * tests can therefore import the real modules — `server/live/*.test.ts` —
 * the way the app does, instead of duplicating them.
 */
import { existsSync, statSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"

/** Extensionless, then the shapes the repo uses between files. */
const SUFFIXES = ["", ".ts", ".tsx", ".mts", ".cts", "/index.ts", "/index.tsx", ".mjs", ".js"]

/** Maps `@/lib/api/core` to `<repo>/lib/api/core(.ts)`. */
function isDirectory(url) {
  try {
    return statSync(fileURLToPath(url)).isDirectory()
  } catch {
    return false
  }
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const rest = specifier.slice(2)
    for (const suffix of SUFFIXES) {
      const candidate = new URL(`${rest}${suffix}`, pathToFileURL(`${process.cwd()}/`))
      if (existsSync(candidate) && !isDirectory(candidate)) {
        return nextResolve(candidate.href, context)
      }
    }
  }
  return nextResolve(specifier, context)
}
