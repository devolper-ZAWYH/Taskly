import assert from "node:assert/strict"
import { test } from "node:test"
import { parseMessage, startSmtpMock } from "../../scripts/smtp-mock.mjs"
import { buildMessage, dotStuff, encodeHeader, formatAddress } from "./mime.ts"
import { sendMessages, SmtpError } from "./smtp.ts"

const message = {
  from: { name: "Taskly", email: "noreply@zawyh.com" },
  to: { name: "عائشة", email: "aisha@example.com" },
  subject: "دعاك عمر إلى Acme على Taskly",
  text: "Hello\n.starts with a dot",
  html: "<p>Hello</p>",
}

test("ASCII headers stay as they are; others become UTF-8 encoded-words", () => {
  assert.equal(encodeHeader("Task created"), "Task created")
  const encoded = encodeHeader(message.subject)
  assert.match(encoded, /^=\?UTF-8\?B\?/)
  for (const word of encoded.split("\r\n ")) assert.ok(word.length <= 75, word)
  assert.equal(parseMessage(`Subject: ${encoded}\r\n\r\n`).subject, message.subject)
})

test("a header can't smuggle in another header", () => {
  assert.equal(encodeHeader("Hi\r\nBcc: x@y.z"), "Hi Bcc: x@y.z")
  assert.equal(formatAddress({ name: 'A "B"', email: "a@b.c" }), '"A B" <a@b.c>')
})

test("the message round-trips: headers, text and HTML parts", () => {
  const raw = buildMessage(message, { date: new Date("2026-10-12T08:00:00Z"), boundary: "b" })
  const parsed = parseMessage(raw)
  assert.equal(parsed.subject, message.subject)
  assert.equal(parsed.text, message.text)
  assert.equal(parsed.html, message.html)
  assert.equal((parsed.headers as Record<string, string>).date, "Mon, 12 Oct 2026 08:00:00 +0000")
  assert.ok(raw.split("\r\n").every((line) => line.length <= 998))
})

test("lines starting with a dot are doubled for SMTP", () => {
  assert.equal(dotStuff(".a\r\nb\r\n.c"), "..a\r\nb\r\n..c")
})

test("sends over SMTP: login, envelope and content arrive", async () => {
  const mock = startSmtpMock({ port: 2599, httpPort: 0, quiet: true })
  try {
    const config = { host: "localhost", port: 2599, secure: false, user: "app@zawyh.com", pass: "x" }
    const results = await sendMessages(config, [message, { ...message, to: { email: "b@example.com" } }])
    assert.deepEqual(results, [null, null])
    assert.equal(mock.messages.length, 2)
    assert.equal(mock.messages[0].authUser, "app@zawyh.com")
    assert.deepEqual(mock.messages[0].to, ["aisha@example.com"])
    assert.equal(mock.messages[0].text, message.text) // the dot line survived
  } finally {
    mock.close()
  }
})

test("never logs in to a remote server without TLS", async () => {
  const config = { host: "mail.example.com", port: 587, secure: false, user: "u", pass: "p" }
  await assert.rejects(sendMessages(config, [message]), SmtpError)
})
