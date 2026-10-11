/**
 * Deployment settings: the app's public URL, email (SMTP), the Google OAuth
 * client and the push key pair. Operators edit them in Platform → Settings,
 * so one build serves every deployment without redeploying.
 *
 * Each group comes wholly from one place: the console if anything of that
 * group is saved there, otherwise the environment (`.dev.vars` / secrets),
 * otherwise it's unset. Secrets saved in the console are AES-GCM encrypted
 * with ENCRYPTION_KEY, the one secret every deployment still sets.
 *
 * Read once per request (or cron run) and cached on the context.
 */
import type { Ctx } from "@/server/context"
import { all } from "@/server/db"
import { decryptToken, encryptToken } from "@/server/google/tokens"

export const SETTING_GROUPS = ["app", "mail", "google", "push"] as const
export type SettingGroup = (typeof SETTING_GROUPS)[number]
export type SettingSource = "console" | "environment" | "unset"

/** Every stored key, its group, the environment variable it replaces, and whether it's secret. */
export const SETTING_KEYS = {
  app_origin: { group: "app", env: "APP_ORIGIN", secret: false },
  smtp_host: { group: "mail", env: "SMTP_HOST", secret: false },
  smtp_port: { group: "mail", env: "SMTP_PORT", secret: false },
  smtp_secure: { group: "mail", env: "SMTP_SECURE", secret: false },
  smtp_user: { group: "mail", env: "SMTP_USER", secret: false },
  smtp_pass: { group: "mail", env: "SMTP_PASS", secret: true },
  mail_from: { group: "mail", env: "MAIL_FROM", secret: false },
  google_client_id: { group: "google", env: "GOOGLE_CLIENT_ID", secret: false },
  google_client_secret: { group: "google", env: "GOOGLE_CLIENT_SECRET", secret: true },
  vapid_public_key: { group: "push", env: "VAPID_PUBLIC_KEY", secret: false },
  vapid_private_key: { group: "push", env: "VAPID_PRIVATE_KEY", secret: true },
} as const satisfies Record<string, { group: SettingGroup; env: keyof CloudflareEnv; secret: boolean }>

export type SettingKey = keyof typeof SETTING_KEYS

export type ResolvedSettings = {
  values: Partial<Record<SettingKey, string>>
  sources: Record<SettingGroup, SettingSource>
}

const cache = new WeakMap<Ctx, Promise<ResolvedSettings>>()

export function settingsOf(ctx: Ctx): Promise<ResolvedSettings> {
  let resolved = cache.get(ctx)
  if (!resolved) {
    resolved = load(ctx)
    cache.set(ctx, resolved)
    resolved.catch(() => cache.delete(ctx))
  }
  return resolved
}

/** After saving: the next read in this request sees the new values. */
export function forgetSettings(ctx: Ctx): void {
  cache.delete(ctx)
}

/** The one deploy-time secret: encrypts saved secrets and Google tokens. */
export function encryptionKey(env: CloudflareEnv): string | null {
  return env.ENCRYPTION_KEY || null
}

async function load(ctx: Ctx): Promise<ResolvedSettings> {
  const rows = await all<{ key: string; value: string }>(
    ctx.db,
    "SELECT key, value FROM platform_settings",
  )
  const saved = new Map(rows.map((row) => [row.key, row.value]))
  const key = encryptionKey(ctx.env)
  const values: Partial<Record<SettingKey, string>> = {}
  const sources = {} as Record<SettingGroup, SettingSource>

  for (const group of SETTING_GROUPS) {
    const keys = (Object.keys(SETTING_KEYS) as SettingKey[]).filter(
      (name) => SETTING_KEYS[name].group === group,
    )
    const fromConsole = keys.some((name) => saved.has(name))
    for (const name of keys) {
      const spec = SETTING_KEYS[name]
      let value = fromConsole ? saved.get(name) : (ctx.env[spec.env] as string | undefined)
      if (value && fromConsole && spec.secret) {
        // Unreadable (ENCRYPTION_KEY missing or changed): treat as unset.
        value = key ? await decryptToken(key, value).catch(() => undefined) : undefined
      }
      if (value?.trim()) values[name] = value.trim()
    }
    sources[group] = fromConsole
      ? "console"
      : keys.some((name) => values[name])
        ? "environment"
        : "unset"
  }
  return { values, sources }
}

/**
 * Replace a group's console values (secrets encrypted). Keys left out of
 * `values` are removed; the caller passes every key it wants kept.
 */
export async function saveGroup(
  ctx: Ctx,
  group: SettingGroup,
  values: Partial<Record<SettingKey, string>>,
  userId: string,
): Promise<void> {
  const key = encryptionKey(ctx.env)
  const now = new Date().toISOString()
  const statements: D1PreparedStatement[] = [deleteGroup(ctx, group)]
  for (const [name, value] of Object.entries(values) as [SettingKey, string][]) {
    if (SETTING_KEYS[name].group !== group || !value) continue
    const stored = SETTING_KEYS[name].secret ? await encryptToken(key!, value) : value
    statements.push(
      ctx.db
        .prepare(
          "INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)",
        )
        .bind(name, stored, now, userId),
    )
  }
  await ctx.db.batch(statements)
  forgetSettings(ctx)
}

/** Drop a group's console values: it goes back to the environment. */
export async function clearGroup(ctx: Ctx, group: SettingGroup): Promise<void> {
  await deleteGroup(ctx, group).run()
  forgetSettings(ctx)
}

function deleteGroup(ctx: Ctx, group: SettingGroup): D1PreparedStatement {
  const keys = (Object.keys(SETTING_KEYS) as SettingKey[]).filter(
    (name) => SETTING_KEYS[name].group === group,
  )
  return ctx.db
    .prepare("DELETE FROM platform_settings WHERE key IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(keys))
}

// ---- What the rest of the app asks for ----------------------------------------------

/** The public address, without a trailing slash, or "" if unset. */
export async function appOrigin(ctx: Ctx): Promise<string> {
  return ((await settingsOf(ctx)).values.app_origin ?? "").replace(/\/$/, "")
}

/** An absolute link into the app (emails, Google footers). */
export async function appUrl(ctx: Ctx, path: string): Promise<string> {
  return `${await appOrigin(ctx)}${path}`
}

export type PushKeys = { publicKey: string; privateKey: string; subject: string }

/** The push key pair, or null when push is off. */
export async function pushKeys(ctx: Ctx): Promise<PushKeys | null> {
  const { values } = await settingsOf(ctx)
  if (!values.vapid_public_key || !values.vapid_private_key) return null
  const origin = await appOrigin(ctx)
  const from = /<([^>]+)>/.exec(values.mail_from ?? "")?.[1] ?? values.smtp_user
  return {
    publicKey: values.vapid_public_key,
    privateKey: values.vapid_private_key,
    // Push services want a contact: the public https address, else the mail sender.
    subject:
      origin.startsWith("https://") || !from
        ? origin || ctx.env.VAPID_SUBJECT || "mailto:admin@localhost"
        : `mailto:${from}`,
  }
}
