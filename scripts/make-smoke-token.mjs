// One-off smoke helper: writes the SQL for a live_device_tokens row and
// saves the raw token to a file for scripts/replay-live.mjs / smoke-live.mjs.
//
//   node scripts/make-smoke-token.mjs [--id lvt-smoke-1] [--user u-admin]
//        [--account acc-acme] [--name "Smoke laptop"]
//        [--raw-out .wrangler/raw-token.txt] [--sql-out .wrangler/live-token.sql]
import { createHash, randomBytes } from "node:crypto"
import { writeFileSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}

const raw = `tsk_lv_${randomBytes(32).toString("hex")}`
const hash = createHash("sha256").update(raw).digest("hex")
const now = new Date().toISOString()
const sqlFile = flag("sql-out", ".wrangler/live-token.sql")
const rawFile = flag("raw-out", ".wrangler/raw-token.txt")
writeFileSync(
  sqlFile,
  `INSERT INTO live_device_tokens (id, account_id, user_id, name, token_hash, last_used, created_at)
   VALUES ('${flag("id", "lvt-smoke-1")}', '${flag("account", "acc-acme")}', '${flag("user", "u-admin")}',
           '${flag("name", "Smoke laptop")}', '${hash}', '${now}', '${now}');`,
)
writeFileSync(rawFile, raw)
console.log(`token written (raw → ${rawFile}, sql → ${sqlFile})`)
