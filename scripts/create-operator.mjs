#!/usr/bin/env node
/**
 * The first platform operator for a new, empty deployment (no demo data):
 *
 *   node scripts/create-operator.mjs --name "Hamza" --email ops@zawyh.com --out operator.sql
 *   npx wrangler d1 execute DB --remote --file operator.sql
 *
 * Prints a random password once; sign in with it and change it in Settings.
 * Add --ask-password to type your own instead (hidden, asked twice).
 * Delete operator.sql afterwards (it holds the password hash). Run after the
 * migrations (`yarn db:migrate:remote`).
 */
import { randomBytes, randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { hashPassword } from "../server/crypto.ts"

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    email: { type: "string" },
    out: { type: "string" },
    "ask-password": { type: "boolean", default: false },
  },
})

/** Read a line from the terminal without echoing it. */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process
    if (!stdin.isTTY) return reject(new Error("--ask-password needs an interactive terminal"))
    stderr.write(question)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding("utf8")
    let value = ""
    // Typed keys arrive one at a time; a paste arrives as one chunk.
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\u0003") process.exit(1) // Ctrl+C
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off("data", onData)
          stderr.write("\n")
          return resolve(value)
        }
        if (char === "\u007f") value = value.slice(0, -1)
        else value += char
      }
    }
    stdin.on("data", onData)
  })
}

const email = values.email?.trim().toLowerCase()
const name = values.name?.trim()
if (!email || !name || !values.out || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: node scripts/create-operator.mjs --name "<name>" --email <email> --out <file.sql>')
  process.exit(1)
}

const q = (value) => `'${String(value).replace(/'/g, "''")}'`
let password = randomBytes(12).toString("base64url")
if (values["ask-password"]) {
  password = await askHidden("Password: ")
  if ((await askHidden("Again: ")) !== password) {
    console.error("The passwords don't match.")
    process.exit(1)
  }
  if (password.length < 8) {
    console.error("Use at least 8 characters.")
    process.exit(1)
  }
}
const now = new Date().toISOString()
const sql = `INSERT INTO users (id, name, email, password_hash, is_operator, active, locale, created_at)
VALUES (${q(`u-${randomUUID()}`)}, ${q(name)}, ${q(email)}, ${q(await hashPassword(password))}, 1, 1, 'en', ${q(now)});
`
writeFileSync(values.out, sql)
console.error(
  values["ask-password"]
    ? `Wrote ${values.out}. Sign in as ${email} with the password you typed.`
    : `Wrote ${values.out}. Sign in as ${email} with this password (shown once):\n\n  ${password}\n`,
)
