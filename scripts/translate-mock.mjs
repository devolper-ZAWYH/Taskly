#!/usr/bin/env node
/**
 * A local stand-in for the translation services, so the translation flow can
 * be tested without real keys:
 *
 *   node scripts/translate-mock.mjs          # http://localhost:3299
 *
 * then set TRANSLATE_API_ORIGIN=http://localhost:3299 in .dev.vars and pick
 * Azure, Google, DeepL, Amazon or Anthropic in Platform → Settings (any key).
 * It answers each service's request format with "[to] text", and checks the
 * parts each service would reject (auth header, body shape, SigV4 header).
 * GET /__requests lists what it received; POST /__reset clears that.
 */
import { createServer } from "node:http"

const PORT = Number(process.env.PORT ?? 3299)
const requests = []

const fake = (text, to) => `[${to}] ${text}`

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body))
}

function handle(req, url, body, res) {
  const json = body ? JSON.parse(body) : null
  // Microsoft Azure Translator v3
  if (url.pathname === "/translate" && url.searchParams.get("api-version") === "3.0") {
    if (!req.headers["ocp-apim-subscription-key"]) return send(res, 401, { error: { code: 401000, message: "Missing key" } })
    const to = url.searchParams.get("to")
    return send(res, 200, json.map((item) => ({ translations: [{ text: fake(item.Text, to), to }] })))
  }
  // Google Cloud Translation v2
  if (url.pathname === "/language/translate/v2") {
    if (!url.searchParams.get("key")) return send(res, 403, { error: { code: 403, message: "No API key" } })
    if (json.format !== "text") return send(res, 400, { error: { code: 400, message: "format must be text" } })
    return send(res, 200, { data: { translations: json.q.map((q) => ({ translatedText: fake(q, json.target) })) } })
  }
  // DeepL v2
  if (url.pathname === "/v2/translate") {
    if (!/^DeepL-Auth-Key \S+/.test(req.headers.authorization ?? "")) return send(res, 403, { message: "Wrong auth" })
    return send(res, 200, {
      translations: json.text.map((text) => ({ detected_source_language: json.source_lang, text: fake(text, json.target_lang) })),
    })
  }
  // Amazon Translate (JSON protocol, SigV4)
  if (req.headers["x-amz-target"] === "AWSShineFrontendService_20170701.TranslateText") {
    const auth = req.headers.authorization ?? ""
    if (!/^AWS4-HMAC-SHA256 Credential=\S+\/\d{8}\/[a-z0-9-]+\/translate\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/.test(auth)) {
      return send(res, 403, { __type: "IncompleteSignatureException", message: "Bad signature header" })
    }
    if (Buffer.byteLength(json.Text) > 10000) return send(res, 400, { __type: "TextSizeLimitExceededException", message: "Too long" })
    return send(res, 200, {
      TranslatedText: fake(json.Text, json.TargetLanguageCode),
      SourceLanguageCode: json.SourceLanguageCode,
      TargetLanguageCode: json.TargetLanguageCode,
    })
  }
  // Anthropic Messages API
  if (url.pathname === "/v1/messages") {
    if (!req.headers["x-api-key"]) return send(res, 401, { type: "error", error: { type: "authentication_error", message: "No key" } })
    const to = /to (Arabic|English)/.exec(json.system ?? "")?.[1] ?? "?"
    const text = json.messages?.[0]?.content ?? ""
    return send(res, 200, {
      id: "msg_mock",
      type: "message",
      role: "assistant",
      model: json.model,
      content: [{ type: "text", text: fake(text, to) }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    })
  }
  return send(res, 404, { message: `Unknown endpoint ${req.method} ${url.pathname}` })
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`)
  if (url.pathname === "/__requests") return send(res, 200, requests)
  if (url.pathname === "/__reset") {
    requests.length = 0
    return send(res, 204, {})
  }
  let body = ""
  req.on("data", (chunk) => (body += chunk))
  req.on("end", () => {
    requests.push({ at: new Date().toISOString(), method: req.method, path: url.pathname, target: req.headers["x-amz-target"] ?? null, body })
    try {
      handle(req, url, body, res)
    } catch (error) {
      send(res, 400, { message: String(error) })
    }
  })
}).listen(PORT, () => console.log(`Translation mock on http://localhost:${PORT}`))
