/**
 * The translation services an operator can pick in Platform → Settings, and
 * what each one needs. Shared by the settings page and the server.
 */

export const TRANSLATION_PROVIDERS = [
  "azure",
  "google",
  "deepl",
  "amazon",
  "cloudflare_llm",
  "cloudflare_m2m100",
  "anthropic",
] as const

export type TranslationProvider = (typeof TRANSLATION_PROVIDERS)[number]

export type ProviderSpec = {
  /** An API key (or AWS secret access key) is required. */
  key: boolean
  /** AWS access key ID. */
  keyId: boolean
  /** Region: required for Amazon; optional for Azure (regional resources). */
  region: "required" | "optional" | false
  /** Model ID, with its default; null when the service has no model choice. */
  model: string | null
}

export const PROVIDER_SPECS: Record<TranslationProvider, ProviderSpec> = {
  azure: { key: true, keyId: false, region: "optional", model: null },
  google: { key: true, keyId: false, region: false, model: null },
  deepl: { key: true, keyId: false, region: false, model: null },
  amazon: { key: true, keyId: true, region: "required", model: null },
  // Runs on this deployment's own Cloudflare account (the AI binding): no key.
  // Qwen3 is multilingual (Arabic included); Llama 3.1 8B (@cf/meta/llama-3.1-8b-instruct-fp8) is cheaper.
  cloudflare_llm: { key: false, keyId: false, region: false, model: "@cf/qwen/qwen3-30b-a3b-fp8" },
  cloudflare_m2m100: { key: false, keyId: false, region: false, model: null },
  anthropic: { key: true, keyId: false, region: false, model: "claude-haiku-5-5" },
}

/** Whether a saved configuration has everything its provider needs. */
export function providerReady(
  provider: string | undefined,
  values: { key?: string; keyId?: string; region?: string },
): provider is TranslationProvider {
  if (!provider || !(TRANSLATION_PROVIDERS as readonly string[]).includes(provider)) return false
  const spec = PROVIDER_SPECS[provider as TranslationProvider]
  return (
    (!spec.key || Boolean(values.key)) &&
    (!spec.keyId || Boolean(values.keyId)) &&
    (spec.region !== "required" || Boolean(values.region))
  )
}
