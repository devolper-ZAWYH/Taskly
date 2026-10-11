#!/usr/bin/env node
/**
 * The first platform operator for a new, empty deployment (no demo data):
 *
 *   node scripts/create-operator.mjs --name "Hamza" --email ops@zawyh.com --out operator.sql
 *   npx wrangler d1 execute DB --remote --file operator.sql
 *
 * Prints a random password once; sign in with it and change it in Settings.
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
  },
})

const email = values.email?.trim().toLowerCase()
const name = values.name?.trim()
if (!email || !name || !values.out || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: node scripts/create-operator.mjs --name "<name>" --email <email> --out <file.sql>')
  process.exit(1)
}

const q = (value) => `'${String(value).replace(/'/g, "''")}'`
const password = randomBytes(12).toString("base64url")
const now = new Date().toISOString()
const sql = `INSERT INTO users (id, name, email, password_hash, is_operator, active, locale, created_at)
VALUES (${q(`u-${randomUUID()}`)}, ${q(name)}, ${q(email)}, ${q(await hashPassword(password))}, 1, 1, 'en', ${q(now)});
`
writeFileSync(values.out, sql)
console.error(`Wrote ${values.out}. Sign in as ${email} with this password (shown once):\n\n  ${password}\n`)
