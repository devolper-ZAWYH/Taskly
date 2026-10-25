/**
 * The meeting-summary services an operator can choose in Platform → Settings →
 * Live meetings → Summaries, behind one interface — the provider-manager
 * pattern of `server/translate/providers.ts`. `on_device` (the default) is the
 * engine's own local model and never reaches the server: `summarizerFor`
 * returns null for it, and the review card shows the draft the engine posted.
 *
 * SUMMARIZE_API_ORIGIN (testing only) sends the HTTP providers to a local mock.
 * Logs carry ids only — never transcript or draft contents.
 */
import Anthropic from "@anthropic-ai/sdk"
import {
  SUMMARY_PROVIDER_SPECS,
  summaryProviderReady,
  type SummaryProvider,
} from "@/lib/summarize"
import type { Ctx } from "@/server/context"
import { settingsOf } from "@/server/settings"

export type Summarizer = {
  /** Which service did it (kept for the Test button's report). */
  name: SummaryProvider
  /** Run one system+user prompt; returns the raw model text. */
  complete(system: string, user: string): Promise<string>
}

const TIMEOUT_MS = 60_000

type Config = { key: string; baseUrl: string; origin: string; model: string }

/** The configured summarizer, or null when summaries stay on device or are incomplete. */
export async function summarizerFor(ctx: Ctx): Promise<Summarizer | null> {
  const { values } = await settingsOf(ctx)
  const provider = (values.live_summary_provider || "on_device") as SummaryProvider
  const config = {
    key: values.live_summary_key ?? "",
    baseUrl: values.live_summary_base_url ?? "",
    // The OpenAI-compatible endpoint has no default model: readiness needs it.
    model: values.live_summary_model ?? "",
  }
  if (provider === "on_device") return null
  if (!summaryProviderReady(provider, config)) return null
  const full: Config = {
    ...config,
    model: config.model || SUMMARY_PROVIDER_SPECS[provider].model || "",
    origin: ((ctx.env as { SUMMARIZE_API_ORIGIN?: string }).SUMMARIZE_API_ORIGIN || "").replace(
      /\/$/,
      "",
    ),
  }
  switch (provider) {
    case "claude":
      return claude(full)
    case "openai_compatible":
      return openAiCompatible(full)
    case "workers_ai":
      return workersAi(ctx.env, full.model)
  }
  // The union has no other member (`on_device` returned above); never reached.
  return null
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

// ---- Anthropic Claude ---------------------------------------------------------------

function claude(config: Config): Summarizer {
  const client = new Anthropic({
    apiKey: config.key,
    ...(config.origin ? { baseURL: config.origin } : {}),
    timeout: TIMEOUT_MS,
    maxRetries: 2,
  })
  return {
    name: "claude",
    async complete(system, user) {
      const message = await client.messages.create({
        model: config.model,
        max_tokens: 4_096,
        system,
        // Minutes need little deliberation: keep it fast and cheap.
        output_config: { effort: "low" },
        messages: [{ role: "user", content: user }],
      })
      if (message.stop_reason === "refusal") throw new Error("Claude declined to summarize this transcript")
      if (message.stop_reason === "max_tokens") throw new Error("The summary was cut off (too long)")
      const text = message.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("")
        .trim()
      if (!text) throw new Error("Claude returned no text")
      return text
    },
  }
}

// ---- OpenAI-compatible chat endpoint ------------------------------------------------

/** Accept the base URL with or without a `/v1` tail, like the OpenAI SDK's baseURL. */
function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, "")
  const withVersion = /\/v\d+(?:beta)?$/.test(base) ? base : `${base}/v1`
  return `${withVersion}/chat/completions`
}

function openAiCompatible(config: Config): Summarizer {
  return {
    name: "openai_compatible",
    async complete(system, user) {
      const url = chatCompletionsUrl(config.origin || config.baseUrl)
      const data = await postJson<{
        choices?: { message?: { content?: string } }[]
      }>(
        "OpenAI-compatible endpoint",
        url,
        { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" },
        JSON.stringify({
          model: config.model,
          temperature: 0,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      )
      const text = data.choices?.[0]?.message?.content
      if (typeof text !== "string" || !text.trim()) {
        throw new Error("The endpoint returned no message content")
      }
      return text
    },
  }
}

// ---- Cloudflare Workers AI (the deployment's AI binding) -----------------------------

/** Workers AI via this deployment's AI binding (wrangler.jsonc), no key needed. */
type AiRunner = { run(model: string, input: unknown): Promise<unknown> }

function aiBinding(env: CloudflareEnv): AiRunner {
  const ai = (env as { AI?: unknown }).AI
  if (!ai) throw new Error("Workers AI isn't bound to this deployment (AI binding missing)")
  return ai as AiRunner
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
  return text.replace(/<\/?think>/g, "").trim()
}

function workersAi(env: CloudflareEnv, model: string): Summarizer {
  return {
    name: "workers_ai",
    async complete(system, user) {
      const ai = aiBinding(env)
      const output = await ai.run(model, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: 4_096,
      })
      const text = llmText(output)
      if (!text) throw new Error("Workers AI returned no text")
      return text
    },
  }
}
