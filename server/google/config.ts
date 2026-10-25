/**
 * Google endpoints, scopes, and whether this deployment can sync at all (an
 * OAuth client in Platform → Settings or the environment, plus ENCRYPTION_KEY
 * for the stored tokens). GOOGLE_API_ORIGIN / GOOGLE_OAUTH_ORIGIN point the
 * app at a mock server in tests (scripts/google-mock.mjs); they are unset in
 * production.
 */
import type { Ctx } from "@/server/context"
import { getConnection } from "@/server/google/store"
import { appOrigin, encryptionKey, settingsOf } from "@/server/settings"

/** Short-lived cookie between /api/google/connect and the callback: `<state>.<PKCE verifier>`. */
export const OAUTH_COOKIE = "google_oauth"

/** Google Tasks: only asked for while tasks sync is switched on. */
export const TASKS_SCOPE = "https://www.googleapis.com/auth/tasks"

const CALENDAR_SCOPES = [
  // Create and manage the "Taskly · <Workspace>" calendars.
  "https://www.googleapis.com/auth/calendar.app.created",
  // List the person's own calendars, and read/write events on them.
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events",
]

/** Sync can't work if the person unticks any of these on the consent screen. */
export function requiredScopes(tasks: boolean): string[] {
  return [...(tasks ? [TASKS_SCOPE] : []), ...CALENDAR_SCOPES]
}

/** What Taskly asks for on Google's consent screen. */
export function scopes(tasks: boolean): string[] {
  return ["openid", "email", ...requiredScopes(tasks)]
}

/**
 * Whether tasks sync with Google Tasks (workspace tasks, private tasks, and
 * people's own task lists in Taskly). Off unless switched on in Platform →
 * Settings → Google. Meetings always sync with Google Calendar.
 */
export async function googleTasksEnabled(ctx: Ctx): Promise<boolean> {
  return (await settingsOf(ctx)).values.google_tasks_sync === "on"
}

/**
 * Tasks sync is on and this person let Taskly into their Google Tasks. Whoever
 * connected while it was off reconnects Google once to start.
 */
export async function tasksSyncFor(ctx: Ctx, userId: string): Promise<boolean> {
  if (!(await googleTasksEnabled(ctx))) return false
  const row = await getConnection(ctx.db, userId)
  return Boolean(row?.scopes.split(" ").includes(TASKS_SCOPE))
}

/** The OAuth client this deployment signs people in to Google with. */
export type GoogleClient = { clientId: string; clientSecret: string }

/** The OAuth client, or null when Google sync isn't set up. */
export async function googleClient(ctx: Ctx): Promise<GoogleClient | null> {
  const { values } = await settingsOf(ctx)
  if (!values.google_client_id || !values.google_client_secret || !encryptionKey(ctx.env)) return null
  return { clientId: values.google_client_id, clientSecret: values.google_client_secret }
}

export async function googleConfigured(ctx: Ctx): Promise<boolean> {
  return (await googleClient(ctx)) !== null
}

export function apiOrigin(env: CloudflareEnv): string {
  return env.GOOGLE_API_ORIGIN || "https://www.googleapis.com"
}

export function oauthEndpoints(env: CloudflareEnv) {
  const mock = env.GOOGLE_OAUTH_ORIGIN
  return mock
    ? { auth: `${mock}/o/oauth2/v2/auth`, token: `${mock}/token`, revoke: `${mock}/revoke` }
    : {
        auth: "https://accounts.google.com/o/oauth2/v2/auth",
        token: "https://oauth2.googleapis.com/token",
        revoke: "https://oauth2.googleapis.com/revoke",
      }
}

/** Where Google Calendar sends push notifications, or null without a public https URL. */
export async function webhookUrl(ctx: Ctx): Promise<string | null> {
  const origin = await appOrigin(ctx)
  if (!origin.startsWith("https://") || /localhost|127\.0\.0\.1/.test(origin)) return null
  return `${origin}/api/google/webhook`
}
