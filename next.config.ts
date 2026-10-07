import type { NextConfig } from "next"

const nextConfig: NextConfig = {}

export default nextConfig

// Lets `next dev` emulate Cloudflare bindings (same setup as the portfolio).
import("@opennextjs/cloudflare").then((m) => m.initOpenNextCloudflareForDev())
