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

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/(.*)", headers: SECURITY_HEADERS }]
  },
}

export default nextConfig

// Lets `next dev` emulate Cloudflare bindings (same setup as the portfolio).
import("@opennextjs/cloudflare").then((m) => m.initOpenNextCloudflareForDev())
