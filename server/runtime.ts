/**
 * Where Taskly runs. On Cloudflare (the default) the bindings and
 * `waitUntil` come from the Worker. With `TASKLY_RUNTIME=node` (a plain
 * Node.js server, e.g. cPanel's "Setup Node.js App") the settings come from
 * environment variables and the database is a SQLite file.
 */
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { openD1 } from "@/server/node/d1"

export const ON_NODE = process.env.TASKLY_RUNTIME === "node"

export type Platform = {
  env: CloudflareEnv
  /** Work to finish after the response is sent. */
  waitUntil: (promise: Promise<unknown>) => void
}

/** Shared across requests (and kept through dev reloads). */
const shared = globalThis as typeof globalThis & { __tasklyNodeEnv?: CloudflareEnv }

/** The environment variables plus the database, as the Worker would see them. */
function nodeEnv(): CloudflareEnv {
  if (!shared.__tasklyNodeEnv) {
    const path = process.env.TASKLY_DB_PATH || "data/taskly.db"
    shared.__tasklyNodeEnv = { ...process.env, DB: openD1(path) } as unknown as CloudflareEnv
  }
  return shared.__tasklyNodeEnv
}

export function platform(): Platform {
  if (ON_NODE) {
    return {
      env: nodeEnv(),
      // No platform to hand it to: let it run, and log if it fails.
      waitUntil: (promise) => {
        promise.catch((error) => console.error("background work failed", error))
      },
    }
  }
  const { env, ctx } = getCloudflareContext()
  return { env, waitUntil: (promise) => ctx.waitUntil(promise) }
}
