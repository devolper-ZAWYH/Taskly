#!/usr/bin/env node
/**
 * Build Taskly for a plain Node.js server (cPanel "Setup Node.js App" or
 * "Application Manager"):
 *
 *   yarn build:cpanel
 *
 * Produces cpanel-build/taskly/ (upload its contents to the app folder) and
 * cpanel-build/taskly-cpanel.tar.gz (the same, as one file to upload and
 * extract). Start file: server.js (app.js starts the same). The database stays on the server in
 * data/, which this package never contains, so uploading a new version keeps it.
 */
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const out = "cpanel-build"
const app = join(out, "taskly")

function run(command, args, env = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", env: { ...process.env, ...env } })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(process.execPath, ["scripts/build-cards.mjs"])
// Next's CLI through node itself: node_modules/.bin/next can't be started directly on Windows.
run(process.execPath, ["node_modules/next/dist/bin/next", "build"], { TASKLY_RUNTIME: "node" })

if (!existsSync(".next/standalone/server.js")) {
  console.error("The build didn't produce .next/standalone/server.js.")
  process.exit(1)
}

rmSync(out, { recursive: true, force: true })
mkdirSync(app, { recursive: true })
// The server and the node_modules it needs, then what it serves as files.
cpSync(".next/standalone", app, { recursive: true })
cpSync(".next/static", join(app, ".next/static"), { recursive: true })
cpSync("public", join(app, "public"), { recursive: true })
// cPanel's Application Manager (Passenger) always starts app.js.
writeFileSync(join(app, "app.js"), 'import "./server.js"\n')
// Database tools for the server.
cpSync("migrations", join(app, "migrations"), { recursive: true })
mkdirSync(join(app, "scripts"), { recursive: true })
cpSync("scripts/cpanel-db.mjs", join(app, "scripts/cpanel-db.mjs"))
// Never ship local secrets or a local database.
for (const name of [".env", ".env.local", ".env.production", ".dev.vars", "data"]) {
  rmSync(join(app, name), { recursive: true, force: true })
}

run("tar", ["-czf", join(out, "taskly-cpanel.tar.gz"), "-C", app, "."])
console.log(`\nReady: ${app}/ and ${out}/taskly-cpanel.tar.gz (start file: server.js, or app.js)`)
