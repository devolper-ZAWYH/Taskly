/**
 * The `--import` entry for the test script: registers scripts/aliases.mjs so
 * `@/…` imports resolve inside `node --test` (see that file for why).
 */
import { register } from "node:module"

register(new URL("./aliases.mjs", import.meta.url))
