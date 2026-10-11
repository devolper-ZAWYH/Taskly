/**
 * The translation services an operator can choose in Platform → Settings,
 * behind one interface. Request shapes follow each vendor's official docs
 * (Azure Translator v3, Google Translation v2, DeepL v2, Amazon Translate
 * TranslateText with SigV4, Workers AI, Anthropic Messages).
 *
 * TRANSLATE_API_ORIGIN (testing only) sends the HTTP providers to a local mock.
 */
import Anthropic from "@anthropic-ai/sdk"
import { PROVIDER_SPECS, providerReady, type TranslationProvider } from "@/lib/translation"
import type { Ctx } from "@/server/context"
import { settingsOf } from "@/server/settings"
import { signAws } from "@/server/translate/aws-sign"
import type { Lang } from "@/server/translate/text"

export type Translator = {
  /** Which service did it (stored with each translation). */
  name: TranslationProvider
  /** Longest piece of text sent in one go; longer text is split by lines. */
  maxChars: number
  /** Translate several texts from one language to the other, in order. */
  translate(texts: string[], from: Lang, to: Lang): Promise<string[]>
}

type Config = { key: string; keyId: string; region: string; model: string; origin: string }

const TIMEOUT_MS = 25_000

/** The configured translator, or null when translation is off or incomplete. */
export async function translatorFor(ctx: Ctx): Promise<Translator | null> {
  const { values } = await settingsOf(ctx)
  const provider = values.translate_provider
  const config = {
    key: values.translate_key ?? "",
    keyId: values.translate_key_id ?? "",
    region: values.translate_region ?? "",
  }
  if (!providerReady(provider, config)) return null
  const full: Config = {
    ...config,
    model: values.translate_model || PROVIDER_SPECS[provider].model || "",
    origin: (ctx.env.TRANSLATE_API_ORIGIN || "").replace(/\/$/, ""),
  }
  switch (provider) {
    case "azure":
      return azure(full)
    case "google":
      return google(full)
    case "deepl":
      return deepl(full)
    case "amazon":
      return amazon(full)
    case "cloudflare_m2m100":
      return cloudflareM2m100(ctx.env)
    case "cloudflare_llm":
      return cloudflareLlm(ctx.env, full.model)
    case "anthropic":
      return anthropic(full)
  }
}

// ---- HTTP helper ----------------------------------------------------------------

/** POST JSON and return the parsed answer; a failure carries the service's own message. */
async function postJson<T>(label: string, url: string, headers: Record<string, string>, body: string): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await response.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    // Not JSON: report the raw text below.
  }
  if (!response.ok) {
    const d = data as { error?: { message?: string } | string; message?: string } | null
    const message =
      (typeof d?.error === "object" ? d.error?.message : d?.error) ?? d?.message ?? text.slice(0, 200)
    throw new Error(`${label} ${response.status}: ${message}`)
  }
  return data as T
}

// ---- Microsoft Azure Translator (v3) --------------------------------------------

function azure(config: Config): Translator {
  return {
    name: "azure",
    maxChars: 10_000,
    async translate(texts, from, to) {
      const base = config.origin || "https://api.cognitive.microsofttranslator.com"
      const url = `${base}/translate?api-version=3.0&from=${from}&to=${to}&textType=plain`
      const data = await postJson<{ translations: { text: string }[] }[]>(
        "Azure Translator",
        url,
        {
          "Ocp-Apim-Subscription-Key": config.key,
          // Required for regional and multi-service resources; omitted for global ones.
          ...(config.region ? { "Ocp-Apim-Subscription-Region": config.region } : {}),
          "Content-Type": "application/json; charset=UTF-8",
        },
        JSON.stringify(texts.map((text) => ({ Text: text }))),
      )
      return data.map((item) => item.translations?.[0]?.text ?? "")
    },
  }
}

// ---- Google Cloud Translation (Basic, v2) ----------------------------------------

function google(config: Config): Translator {
  return {
    name: "google",
    maxChars: 5_000,
    async translate(texts, from, to) {
      const base = config.origin || "https://translation.googleapis.com"
      const data = await postJson<{ data: { translations: { translatedText: string }[] } }>(
        "Google Translation",
        `${base}/language/translate/v2?key=${encodeURIComponent(config.key)}`,
        { "Content-Type": "application/json; charset=UTF-8" },
        // format "text": the default is HTML, which would escape and reflow plain text.
        JSON.stringify({ q: texts, source: from, target: to, format: "text" }),
      )
      return data.data.translations.map((item) => item.translatedText)
    },
  }
}

// ---- DeepL (v2) -------------------------------------------------------------------

function deepl(config: Config): Translator {
  return {
    name: "deepl",
    maxChars: 10_000,
    async translate(texts, from, to) {
      // Free-plan keys end in ":fx" and use their own host.
      const host = config.key.endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com"
      const data = await postJson<{ translations: { text: string }[] }>(
        "DeepL",
        `${config.origin || host}/v2/translate`,
        { Authorization: `DeepL-Auth-Key ${config.key}`, "Content-Type": "application/json" },
        JSON.stringify({
          text: texts,
          source_lang: from === "ar" ? "AR" : "EN",
          target_lang: to === "ar" ? "AR" : "EN-US",
          // Keep line breaks as they are (agendas are lists).
          split_sentences: "nonewlines",
          preserve_formatting: true,
        }),
      )
      return data.translations.map((item) => item.text)
    },
  }
}

// ---- Amazon Translate (TranslateText, signed with SigV4) ---------------------------

function amazon(config: Config): Translator {
  return {
    name: "amazon",
    // At most 10,000 bytes of UTF-8 per request; Arabic letters take 2 bytes.
    maxChars: 4_500,
    async translate(texts, from, to) {
      const host = `translate.${config.region}.amazonaws.com`
      const results: string[] = []
      // One text per request: TranslateText has no batching.
      for (const text of texts) {
        const body = JSON.stringify({ Text: text, SourceLanguageCode: from, TargetLanguageCode: to })
        const headers = await signAws({
          host,
          region: config.region,
          service: "translate",
          target: "AWSShineFrontendService_20170701.TranslateText",
          body,
          keyId: config.keyId,
          secret: config.key,
        })
        const data = await postJson<{ TranslatedText: string }>(
          "Amazon Translate",
          `${config.origin || `https://${host}`}/`,
          headers,
          body,
        )
        results.push(data.TranslatedText)
      }
      return results
    },
  }
}

// ---- Cloudflare Workers AI ---------------------------------------------------------

/** Workers AI via this deployment's AI binding (wrangler.jsonc), no key needed. */
type AiRunner = { run(model: string, input: unknown): Promise<unknown> }

function aiBinding(env: CloudflareEnv): AiRunner {
  const ai = (env as { AI?: unknown }).AI
  if (!ai) throw new Error("Workers AI isn't bound to this deployment (AI binding missing)")
  return ai as AiRunner
}

function cloudflareM2m100(env: CloudflareEnv): Translator {
  return {
    name: "cloudflare_m2m100",
    maxChars: 1_000,
    async translate(texts, from, to) {
      const ai = aiBinding(env)
      const results: string[] = []
      for (const text of texts) {
        const output = (await ai.run("@cf/meta/m2m100-1.2b", {
          text,
          source_lang: from,
          target_lang: to,
        })) as { translated_text?: string }
        if (typeof output?.translated_text !== "string") {
          throw new Error("Workers AI m2m100 returned no translation")
        }
        results.push(output.translated_text)
      }
      return results
    },
  }
}

const LANGUAGE_NAMES: Record<Lang, string> = { en: "English", ar: "Arabic" }

/** Instructions for AI models: the translation only, layout and names untouched. */
function systemPrompt(from: Lang, to: Lang): string {
  return [
    `You translate meeting titles and agendas from ${LANGUAGE_NAMES[from]} to ${LANGUAGE_NAMES[to]} for a business team.`,
    "Reply with the translation only: no notes, quotes, explanations or preamble.",
    "Keep every line break, bullet and number in place.",
    "Leave people's and company names, numbers, dates, times, links and email addresses as they are.",
    to === "ar"
      ? "Write clear Modern Standard Arabic suitable for business."
      : "Write clear, natural business English.",
  ].join(" ")
}

/** The text of a Workers AI text-generation result (models answer in different shapes). */
function llmText(output: unknown): string {
  const o = output as {
    response?: string
    output_text?: string
    choices?: { message?: { content?: string } }[]
  }
  const text = o?.response ?? o?.choices?.[0]?.message?.content ?? o?.output_text
  if (typeof text !== "string") throw new Error("Workers AI returned no text")
  // Some models think out loud first; keep only the answer.
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
}

function cloudflareLlm(env: CloudflareEnv, model: string): Translator {
  return {
    name: "cloudflare_llm",
    maxChars: 4_000,
    async translate(texts, from, to) {
      const ai = aiBinding(env)
      const results: string[] = []
      for (const text of texts) {
        const output = await ai.run(model, {
          messages: [
            { role: "system", content: systemPrompt(from, to) },
            { role: "user", content: text },
          ],
          max_tokens: 4096,
        })
        results.push(llmText(output))
      }
      return results
    },
  }
}

// ---- Anthropic Claude ---------------------------------------------------------------

function anthropic(config: Config): Translator {
  const client = new Anthropic({
    apiKey: config.key,
    ...(config.origin ? { baseURL: config.origin } : {}),
    timeout: TIMEOUT_MS * 2,
    maxRetries: 2,
  })
  return {
    name: "anthropic",
    maxChars: 8_000,
    async translate(texts, from, to) {
      const results: string[] = []
      for (const text of texts) {
        const message = await client.messages.create({
          model: config.model,
          max_tokens: 16_000,
          system: systemPrompt(from, to),
          // Translation needs little deliberation: keep it fast and cheap.
          output_config: { effort: "low" },
          messages: [{ role: "user", content: text }],
        })
        if (message.stop_reason === "refusal") throw new Error("Claude declined to translate this text")
        if (message.stop_reason === "max_tokens") throw new Error("The translation was cut off (too long)")
        const translated = message.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("")
          .trim()
        if (!translated) throw new Error("Claude returned no text")
        results.push(translated)
      }
      return results
    },
  }
}
