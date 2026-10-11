/**
 * Google endpoints, scopes, and whether this deployment can sync at all (an
 * OAuth client in Platform → Settings or the environment, plus ENCRYPTION_KEY
 * for the stored tokens). GOOGLE_API_ORIGIN / GOOGLE_OAUTH_ORIGIN point the
 * app at a mock server in tests (scripts/google-mock.mjs); they are unset in
 * production.
 */
import type { Ctx } from "@/server/context"
import { appOrigin, encryptionKey, settingsOf } from "@/server/settings"

/** Short-lived cookie between /api/google/connect and the callback: `<state>.<PKCE verifier>`. */
export const OAUTH_COOKIE = "google_oauth"

/** What Taskly asks for on Google's consent screen. */
export const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/tasks",
  // Create and manage the "Taskly · <Workspace>" calendars.
  "https://www.googleapis.com/auth/calendar.app.created",
  // List the person's own calendars, and read/write events on them.
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events",
]

/** Sync can't work if the person unticks any of these on the consent screen. */
export const REQUIRED_SCOPES = SCOPES.slice(2)

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
