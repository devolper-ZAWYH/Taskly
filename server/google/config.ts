/**
 * Google endpoints, scopes, and whether this deployment can sync at all.
 * GOOGLE_API_ORIGIN / GOOGLE_OAUTH_ORIGIN point the app at a mock server in
 * tests (scripts/google-mock.mjs); they are unset in production.
 */

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

export function googleConfigured(env: CloudflareEnv): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_TOKEN_KEY)
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

/** A link into the app, for the footer Taskly writes into Google items. */
export function appUrl(env: CloudflareEnv, path: string): string {
  return `${(env.APP_ORIGIN || "").replace(/\/$/, "")}${path}`
}

/** Where Google Calendar sends push notifications, or null without a public https URL. */
export function webhookUrl(env: CloudflareEnv): string | null {
  const origin = env.APP_ORIGIN || ""
  if (!origin.startsWith("https://") || /localhost|127\.0\.0\.1/.test(origin)) return null
  return appUrl(env, "/api/google/webhook")
}
