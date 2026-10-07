/**
 * Writes SQL that loads the sample workspaces from lib/seed.ts into D1, with
 * hashed passwords. Run on an empty, migrated database:
 *
 *   node scripts/seed.mjs --out seed.sql                     # documented demo passwords
 *   node scripts/seed.mjs --out seed.sql --random-passwords  # new passwords, printed once
 *   wrangler d1 execute DB --local --file seed.sql           # or --remote
 */
import { randomBytes } from "node:crypto"
import { writeFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { hashPassword } from "../server/crypto.ts"
import {
  buildNorthwindMeetings,
  buildNorthwindTasks,
  buildSeedMeetings,
  buildSeedTasks,
  SEED_ACCOUNTS,
  SEED_MEMBERSHIPS,
  SEED_USERS,
} from "../lib/seed.ts"

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    "random-passwords": { type: "boolean", default: false },
  },
})
if (!values.out) {
  console.error("Usage: node scripts/seed.mjs --out <file.sql> [--random-passwords]")
  process.exit(1)
}

const q = (value) =>
  value === null || value === undefined
    ? "NULL"
    : typeof value === "number"
      ? String(value)
      : typeof value === "boolean"
        ? (value ? "1" : "0")
        : `'${String(value).replaceAll("'", "''")}'`
const insert = (table, row) =>
  `INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(q).join(", ")});`

const lines = []
const credentials = []

for (const user of SEED_USERS) {
  const password = values["random-passwords"] ? randomBytes(9).toString("base64url") : user.password
  credentials.push({ email: user.email, password })
  lines.push(
    insert("users", {
      id: user.id,
      name: user.name,
      email: user.email,
      password_hash: await hashPassword(password),
      is_operator: user.isOperator,
      active: user.active,
      locale: user.locale,
      created_at: user.createdAt,
    }),
  )
}

const tasks = [...buildSeedTasks(), ...buildNorthwindTasks()]
for (const account of SEED_ACCOUNTS) {
  const counter = Math.max(0, ...tasks.filter((t) => t.accountId === account.id).map((t) => t.number))
  lines.push(
    insert("accounts", {
      id: account.id,
      name: account.name,
      active: account.active,
      task_counter: counter,
      created_at: account.createdAt,
    }),
  )
}

for (const m of SEED_MEMBERSHIPS) {
  lines.push(
    insert("memberships", {
      id: m.id,
      account_id: m.accountId,
      user_id: m.userId,
      role: m.role,
      created_at: m.createdAt,
    }),
  )
}

for (const m of [...buildSeedMeetings(), ...buildNorthwindMeetings()]) {
  lines.push(
    insert("meetings", {
      id: m.id,
      account_id: m.accountId,
      title: m.title,
      notes: m.notes,
      date: m.date,
      start_time: m.startTime,
      end_time: m.endTime,
      location: m.location,
      organizer_id: m.organizerId,
      created_at: m.createdAt,
      updated_at: m.updatedAt,
    }),
  )
  for (const userId of m.attendeeIds) {
    lines.push(insert("meeting_attendees", { meeting_id: m.id, user_id: userId }))
  }
}

for (const t of tasks) {
  lines.push(
    insert("tasks", {
      id: t.id,
      account_id: t.accountId,
      number: t.number,
      title: t.title,
      description: t.description,
      status: t.status,
      priority: t.priority,
      start_date: t.startDate,
      start_time: t.startTime,
      due_date: t.dueDate,
      due_time: t.dueTime,
      created_by_id: t.createdById,
      meeting_id: t.meetingId,
      completed_at: t.completedAt,
      created_at: t.createdAt,
      updated_at: t.updatedAt,
    }),
  )
  for (const userId of t.assigneeIds) {
    lines.push(insert("task_assignees", { task_id: t.id, user_id: userId }))
  }
}

writeFileSync(values.out, lines.join("\n") + "\n")
console.error(`Wrote ${lines.length} statements to ${values.out}`)
if (values["random-passwords"]) {
  console.error("\nSign-in details (shown once — store them safely):")
  for (const c of credentials) console.error(`  ${c.email}  ${c.password}`)
}
