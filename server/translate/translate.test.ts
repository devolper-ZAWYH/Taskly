import assert from "node:assert/strict"
import { createHash, createHmac } from "node:crypto"
import { test } from "node:test"
import { awsSigningKey, signAws } from "./aws-sign.ts"
import { translateText, type Lang } from "./text.ts"

test("SigV4 signing key matches AWS's published example", async () => {
  // docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
  const key = await awsSigningKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20150830", "us-east-1", "iam")
  assert.equal(
    Buffer.from(key).toString("hex"),
    "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9",
  )
})

test("SigV4 headers for TranslateText follow the recipe", async () => {
  const body = '{"Text":"مرحبا","SourceLanguageCode":"ar","TargetLanguageCode":"en"}'
  const at = new Date("2026-10-12T08:30:00.000Z")
  const headers = await signAws(
    {
      host: "translate.eu-central-1.amazonaws.com",
      region: "eu-central-1",
      service: "translate",
      target: "AWSShineFrontendService_20170701.TranslateText",
      body,
      keyId: "AKIDEXAMPLE",
      secret: "secret",
    },
    at,
  )
  assert.equal(headers["X-Amz-Date"], "20261012T083000Z")
  // Recompute independently with Node's crypto.
  const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex")
  const canonical = [
    "POST",
    "/",
    "",
    "content-type:application/x-amz-json-1.1\nhost:translate.eu-central-1.amazonaws.com\nx-amz-date:20261012T083000Z\nx-amz-target:AWSShineFrontendService_20170701.TranslateText\n",
    "content-type;host;x-amz-date;x-amz-target",
    sha(body),
  ].join("\n")
  const scope = "20261012/eu-central-1/translate/aws4_request"
  const toSign = ["AWS4-HMAC-SHA256", "20261012T083000Z", scope, sha(canonical)].join("\n")
  let k: Buffer = createHmac("sha256", "AWS4secret").update("20261012").digest()
  for (const part of ["eu-central-1", "translate", "aws4_request"]) k = createHmac("sha256", k).update(part).digest()
  const signature = createHmac("sha256", k).update(toSign).digest("hex")
  assert.equal(
    headers.Authorization,
    `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/${scope}, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=${signature}`,
  )
})

/** A fake provider that tags what it translated and records its calls. */
function fake(maxChars: number) {
  const calls: string[][] = []
  return {
    calls,
    translator: {
      maxChars,
      async translate(texts: string[], from: Lang, to: Lang) {
        calls.push(texts)
        return texts.map((t) => `[${from}>${to}] ${t}`)
      },
    },
  }
}

test("translation keeps the agenda's layout and leaves number-only lines alone", async () => {
  const { translator, calls } = fake(1000)
  const agenda = "١. الميزانية\n\n10:30 – 11:00\n- العقد"
  const out = await translateText(translator, agenda, "ar", "en")
  // One chunk (whole agenda fits); the times line rides along unchanged inside it.
  assert.equal(calls.length, 1)
  assert.equal(out, `[ar>en] ${agenda}`)
})

test("long text goes in several chunks, rejoined in order", async () => {
  const { translator, calls } = fake(15)
  const out = await translateText(translator, "- alpha\n- beta\n- gamma", "en", "ar")
  assert.equal(calls[0].length, 2)
  assert.equal(out, "[en>ar] - alpha\n- beta\n[en>ar] - gamma")
})

test("a chunk with no words isn't sent at all", async () => {
  const { translator, calls } = fake(8)
  const out = await translateText(translator, "Budget\n10:30", "en", "ar")
  assert.deepEqual(calls[0], ["Budget"])
  assert.equal(out, "[en>ar] Budget\n10:30")
})

test("a provider that returns fewer results is an error, not a silent gap", async () => {
  const bad = { maxChars: 100, translate: async () => [] }
  await assert.rejects(translateText(bad, "Budget", "en", "ar"), /incomplete/)
})
