import type { NextConfig } from "next"

/**
 * Security headers on every page and API response. The CSP only limits what
 * can't break the app (framing, <base>, plugins, form targets); static files
 * get the same headers from public/_headers, since Cloudflare serves them
 * without running Next.
 */
const SECURITY_HEADERS = [
  // Nobody may show Taskly inside a frame (clickjacking).
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  // Browsers only honour this over https, so local http development is unaffected.
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
]

/** `yarn build:cpanel` builds for a plain Node.js server instead of Cloudflare. */
const forNode = process.env.TASKLY_RUNTIME === "node"

const nextConfig: NextConfig = {
  // A self-contained server (server.js + only the files it needs), for cPanel.
  ...(forNode ? { output: "standalone" as const } : {}),
  async headers() {
    return [{ source: "/(.*)", headers: SECURITY_HEADERS }]
  },
}

export default nextConfig

// Lets `next dev` emulate Cloudflare bindings (same setup as the portfolio).
// Workers AI can't run locally: its binding reaches the real Cloudflare
// account, which needs `wrangler login`. That is opt-in (TASKLY_DEV_REMOTE_AI=1)
// so a laptop runs Taskly with no Cloudflare account; without it only the
// Workers AI translation and summary options fail ("needs to be run remotely").
const remoteBindings = process.env.TASKLY_DEV_REMOTE_AI === "1"
if (!forNode) {
  import("@opennextjs/cloudflare").then((m) => m.initOpenNextCloudflareForDev({ remoteBindings }))
}
