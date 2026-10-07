import { defineCloudflareConfig } from "@opennextjs/cloudflare"

// No incremental cache needed: every page is rendered per request and all
// app data lives in the visitor's browser (localStorage).
export default defineCloudflareConfig({})
