/**
 * Name of the cookie that remembers the UI language. Kept out of the
 * "use client" locale provider so Server Components (the root layout) get the
 * string itself, not a client reference.
 */
export const LOCALE_COOKIE = "tasks-locale"
