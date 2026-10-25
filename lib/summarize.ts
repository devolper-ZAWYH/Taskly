/**
 * The meeting-summary services an operator can pick in Platform → Settings →
 * Live meetings → Summaries, and what each one needs. Shared by the settings
 * page and the server, like `lib/translation.ts` for translation.
 */

export const SUMMARY_PROVIDERS = [
  "on_device",
  "claude",
  "openai_compatible",
  "workers_ai",
] as const

export type SummaryProvider = (typeof SUMMARY_PROVIDERS)[number]

export type SummaryProviderSpec = {
  /** An API key is required. */
  key: boolean
  /** A base URL (OpenAI-compatible endpoint) is required. */
  baseUrl: boolean
  /** Model ID, with its default; null when the service has no model choice. */
  model: string | null
}

export const SUMMARY_PROVIDER_SPECS: Record<SummaryProvider, SummaryProviderSpec> = {
  // The default: the desktop engine's own local model writes the draft and
  // posts it (POST /api/live/sessions/[id]/draft). The server does nothing.
  on_device: { key: false, baseUrl: false, model: null },
  // The Anthropic default matches the translation provider (lib/translation.ts).
  claude: { key: true, baseUrl: false, model: "claude-haiku-5-5" },
  // Any OpenAI-shapes chat endpoint: base URL, key and model are all required
  // (there is no service to default the model to).
  openai_compatible: { key: true, baseUrl: true, model: null },
  // Runs on this deployment's own Cloudflare account (the AI binding): no key.
  // Same default model as translation's cloudflare_llm option.
  workers_ai: { key: false, baseUrl: false, model: "@cf/qwen/qwen3-30b-a3b-fp8" },
}

/** Whether a saved configuration has everything its provider needs. */
export function summaryProviderReady(
  provider: string | undefined,
  values: { key?: string; baseUrl?: string; model?: string },
): provider is SummaryProvider {
  if (!provider || provider === "on_device") return true
  if (!(SUMMARY_PROVIDERS as readonly string[]).includes(provider)) return false
  const spec = SUMMARY_PROVIDER_SPECS[provider as SummaryProvider]
  return (
    (!spec.key || Boolean(values.key)) &&
    (!spec.baseUrl || Boolean(values.baseUrl)) &&
    (!spec.baseUrl || Boolean(values.model))
  )
}
