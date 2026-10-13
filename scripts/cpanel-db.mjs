#!/usr/bin/env node
/**
 * The SQLite database of a Node.js (cPanel) install. Run from the app folder,
 * with the same TASKLY_DB_PATH as the app (default data/taskly.db):
 *
 *   node scripts/cpanel-db.mjs migrate            # apply new migrations (after every upload)
 *   node scripts/cpanel-db.mjs import taskly.sql  # load an export of the Cloudflare database (empty database only)
 *   node scripts/cpanel-db.mjs run operator.sql   # run a SQL file (e.g. from create-operator.mjs)
 *   node scripts/cpanel-db.mjs backup             # copy to backups/, keeping the newest 14
 *
 * Needs Node.js 22.13+ (built-in SQLite), or the better-sqlite3 package.
 * Migration history uses the same table as Cloudflare's (d1_migrations), so an
 * imported database knows which migrations it already has.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"

const dbPath = resolve(process.env.TASKLY_DB_PATH || "data/taskly.db")
const [command, file] = process.argv.slice(2)

function open() {
  mkdirSync(dirname(dbPath), { recursive: true })
  const sqlite = process.getBuiltinModule?.("node:sqlite")
  const db = sqlite?.DatabaseSync
    ? new sqlite.DatabaseSync(dbPath)
    : new (createRequire(`${process.cwd()}/`)("better-sqlite3"))(dbPath)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA busy_timeout = 5000")
  return db
}

function tables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => row.name)
}

function migrate() {
  const db = open()
  db.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`)
  const done = new Set(db.prepare("SELECT name FROM d1_migrations").all().map((row) => row.name))
  const pending = readdirSync("migrations")
    .filter((name) => name.endsWith(".sql") && !done.has(name))
    .sort()
  if (pending.length === 0) return console.log(`No migrations to apply (${dbPath}).`)
  for (const name of pending) {
    db.exec("BEGIN IMMEDIATE")
    try {
      db.exec(readFileSync(join("migrations", name), "utf8"))
      db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name)
      db.exec("COMMIT")
      console.log(`✓ ${name}`)
    } catch (error) {
      db.exec("ROLLBACK")
      console.error(`✗ ${name}: ${error.message}`)
      process.exit(1)
    }
  }
  console.log(`Applied ${pending.length} migration(s) to ${dbPath}.`)
}

function runFile({ requireEmpty }) {
  if (!file || !existsSync(file)) {
    console.error("Give the SQL file to load, e.g. taskly.sql")
    process.exit(1)
  }
  const db = open()
  const existing = tables(db)
  if (requireEmpty && existing.length > 0) {
    console.error(
      `${dbPath} already has tables (${existing.length}). Import only into a new, empty database: move or delete it first.`,
    )
    process.exit(1)
  }
  db.exec(readFileSync(file, "utf8"))
  console.log(`Loaded ${file} into ${dbPath}. Tables now: ${tables(db).length}.`)
}

function backup() {
  if (!existsSync(dbPath)) {
    console.error(`No database at ${dbPath}.`)
    process.exit(1)
  }
  const db = open()
  const dir = resolve(dirname(dbPath), "..", "backups")
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const target = join(dir, `taskly-${stamp}.db`)
  // A consistent copy, even while the app is writing.
  db.prepare("VACUUM INTO ?").run(target)
  const old = readdirSync(dir)
    .filter((name) => /^taskly-.*\.db$/.test(name))
    .sort()
    .slice(0, -14)
  for (const name of old) rmSync(join(dir, name))
  console.log(`Backed up to ${target}${old.length ? ` (removed ${old.length} older)` : ""}.`)
}

switch (command) {
  case "migrate":
    migrate()
    break
  case "import":
    runFile({ requireEmpty: true })
    break
  case "run":
    runFile({ requireEmpty: false })
    break
  case "backup":
    backup()
    break
  default:
    console.error("Usage: node scripts/cpanel-db.mjs migrate | import <file.sql> | run <file.sql> | backup")
    process.exit(1)
}
