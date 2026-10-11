/**
 * AWS Signature Version 4 for a JSON POST (Amazon Translate's TranslateText),
 * following the IAM "Create a signed AWS API request" recipe. WebCrypto only,
 * so it runs on Workers and under `node --test`.
 */

const encoder = new TextEncoder()
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("")
const sha256 = async (text: string) => hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)))

async function hmac(key: ArrayBuffer, text: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return crypto.subtle.sign("HMAC", imported, encoder.encode(text))
}

/** The SigV4 signing key: HMAC chain over date, region, service. Exported for tests. */
export async function awsSigningKey(
  secret: string,
  day: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kDate = await hmac(encoder.encode(`AWS4${secret}`).buffer as ArrayBuffer, day)
  const kRegion = await hmac(kDate, region)
  const kService = await hmac(kRegion, service)
  return hmac(kService, "aws4_request")
}

/** AWS Signature Version 4 for one JSON POST to `host` (path "/"). Exported for tests. */
export async function signAws(
  {
    host,
    region,
    service,
    target,
    body,
    keyId,
    secret,
  }: {
    host: string
    region: string
    service: string
    target: string
    body: string
    keyId: string
    secret: string
  },
  now = new Date(),
): Promise<Record<string, string>> {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
  const day = amzDate.slice(0, 8)
  const contentType = "application/x-amz-json-1.1"
  const signedHeaders = "content-type;host;x-amz-date;x-amz-target"
  const canonicalRequest = [
    "POST",
    "/",
    "",
    `content-type:${contentType}\nhost:${host}\nx-amz-date:${amzDate}\nx-amz-target:${target}\n`,
    signedHeaders,
    await sha256(body),
  ].join("\n")
  const scope = `${day}/${region}/${service}/aws4_request`
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonicalRequest)].join("\n")
  const kSigning = await awsSigningKey(secret, day, region, service)
  const signature = hex(await hmac(kSigning, stringToSign))
  return {
    "Content-Type": contentType,
    "X-Amz-Date": amzDate,
    "X-Amz-Target": target,
    Authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}
