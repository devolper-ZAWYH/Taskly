#!/usr/bin/env node
/**
 * A local stand-in for the mail server, so invitations and email
 * notifications can be tested without sending real email:
 *
 *   node scripts/smtp-mock.mjs        # SMTP on localhost:2525, viewer on :2526
 *
 * then in .dev.vars: SMTP_HOST=localhost, SMTP_PORT=2525, SMTP_SECURE=false,
 * and any SMTP_USER / SMTP_PASS. Plain SMTP, no TLS (the app only allows that
 * for a server on this machine). Accepts any login and every message.
 *
 * GET http://localhost:2526/ lists the messages (newest first) with their
 * decoded text; GET /__mail returns them as JSON; POST /__reset clears them.
 */
import { createServer as createHttpServer } from "node:http"
import { createServer } from "node:net"
import { pathToFileURL } from "node:url"

/** Decode =?UTF-8?B?…?= words in a header. */
function decodeHeader(value) {
  return value.replace(/=\?UTF-8\?B\?([^?]*)\?=\s*/gi, (_m, b64) =>
    Buffer.from(b64, "base64").toString("utf8"),
  )
}

/** Headers and the decoded text/plain and text/html parts of a MIME message. */
export function parseMessage(raw) {
  const [head, ...rest] = raw.split("\r\n\r\n")
  const headers = {}
  for (const line of head.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const at = line.indexOf(":")
    if (at > 0) headers[line.slice(0, at).toLowerCase()] = decodeHeader(line.slice(at + 1).trim())
  }
  const body = rest.join("\r\n\r\n")
  const part = (type) => {
    const match = new RegExp(`Content-Type: ${type}[^\\r\\n]*\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]+)`).exec(body)
    return match ? Buffer.from(match[1].replace(/\r\n/g, ""), "base64").toString("utf8") : ""
  }
  return { headers, subject: headers.subject ?? "", text: part("text/plain"), html: part("text/html") }
}

/** Start the mock. Returns the stored messages and a `close()`. */
export function startSmtpMock({ port = 2525, httpPort = 2526, quiet = false } = {}) {
  const messages = []
  const smtp = createServer((socket) => {
    let buffer = ""
    let inData = false
    let data = []
    let envelope = { from: "", to: [] }
    let authUser = ""
    const reply = (line) => socket.write(`${line}\r\n`)
    reply("220 localhost Taskly mock SMTP")
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      let at
      while ((at = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        if (inData) {
          if (line === ".") {
            inData = false
            const raw = data.join("\r\n")
            const message = { id: messages.length + 1, at: new Date().toISOString(), authUser, ...envelope, raw, ...parseMessage(raw) }
            messages.push(message)
            if (!quiet) console.log(`mail #${message.id} to ${envelope.to.join(", ")}: ${message.subject}`)
            reply("250 OK queued")
            data = []
          } else {
            data.push(line.startsWith("..") ? line.slice(1) : line)
          }
          continue
        }
        const verb = line.split(" ")[0].toUpperCase()
        if (verb === "EHLO" || verb === "HELO") {
          socket.write("250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n")
        } else if (verb === "AUTH") {
          const plain = line.split(" ")[2]
          if (plain) authUser = Buffer.from(plain, "base64").toString("utf8").split("\u0000")[1] ?? ""
          reply("235 Authenticated")
        } else if (verb === "MAIL") {
          envelope = { from: /<([^>]*)>/.exec(line)?.[1] ?? "", to: [] }
          reply("250 OK")
        } else if (verb === "RCPT") {
          envelope.to.push(/<([^>]*)>/.exec(line)?.[1] ?? "")
          reply("250 OK")
        } else if (verb === "DATA") {
          inData = true
          reply("354 End data with <CR><LF>.<CR><LF>")
        } else if (verb === "RSET" || verb === "NOOP") {
          reply("250 OK")
        } else if (verb === "QUIT") {
          reply("221 Bye")
          socket.end()
        } else {
          reply("502 Not implemented")
        }
      }
    })
    socket.on("error", () => {})
  })
  smtp.listen(port)

  const http = httpPort
    ? createHttpServer((req, res) => {
        if (req.method === "POST" && req.url === "/__reset") {
          messages.length = 0
          return res.writeHead(204).end()
        }
        if (req.url === "/__mail") {
          res.writeHead(200, { "content-type": "application/json" })
          return res.end(JSON.stringify([...messages].reverse(), null, 2))
        }
        const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        res.end(
          `<!doctype html><meta charset="utf-8"><title>Mock mail</title><body style="font-family:sans-serif;max-width:760px;margin:24px auto">` +
            `<h1>Mock mail (${messages.length})</h1>` +
            [...messages]
              .reverse()
              .map(
                (m) =>
                  `<section style="border:1px solid #ddd;border-radius:8px;padding:12px;margin:12px 0">` +
                  `<b>#${m.id} ${esc(m.subject)}</b><br><small>${esc(m.headers.from ?? "")} → ${esc(m.headers.to ?? "")} · ${m.at}</small>` +
                  `<pre style="white-space:pre-wrap">${esc(m.text)}</pre></section>`,
              )
              .join(""),
        )
      })
    : null
  http?.listen(httpPort)
  if (!quiet) console.log(`Mock SMTP on localhost:${port}${httpPort ? `, mail viewer on http://localhost:${httpPort}` : ""}`)
  return {
    messages,
    close: () => {
      smtp.close()
      http?.close()
    },
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startSmtpMock({ port: Number(process.env.PORT ?? 2525), httpPort: Number(process.env.HTTP_PORT ?? 2526) })
}
