/**
 * A small SMTP client: one connection, AUTH, then any number of messages.
 * Built on `node:tls` / `node:net`, which both `next dev` (Node) and Workers
 * (`nodejs_compat`) provide, so the same code sends locally and in production.
 *
 * Use implicit TLS (port 465, `secure`). Without TLS it only talks to a server
 * on this machine (the local mock), so a password never crosses the network
 * in the clear. Workers can't connect to port 25.
 */
import { connect as netConnect, type Socket } from "node:net"
import { connect as tlsConnect } from "node:tls"
// Relative, with the extension, so `node --test` can load it too.
import { buildMessage, dotStuff, type MailMessage } from "./mime.ts"

export type SmtpConfig = {
  host: string
  port: number
  /** Implicit TLS from the first byte (port 465). */
  secure: boolean
  user: string
  pass: string
}

export class SmtpError extends Error {
  readonly code: number | null

  constructor(message: string, code: number | null = null) {
    super(message)
    this.name = "SmtpError"
    this.code = code
  }
}

const TIMEOUT_MS = 20_000
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"]

type Reply = { code: number; text: string }

/** Line-oriented reader over a socket: resolves one (possibly multi-line) reply at a time. */
class Connection {
  private buffer = ""
  private lines: string[] = []
  private waiting: ((error: Error | null) => void) | null = null
  private failure: Error | null = null
  private readonly socket: Socket

  constructor(socket: Socket) {
    this.socket = socket
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      this.buffer += chunk
      let at: number
      while ((at = this.buffer.indexOf("\r\n")) !== -1) {
        this.lines.push(this.buffer.slice(0, at))
        this.buffer = this.buffer.slice(at + 2)
      }
      this.wake(null)
    })
    socket.on("error", (error: Error) => this.fail(error))
    socket.on("close", () => this.fail(new SmtpError("The mail server closed the connection")))
  }

  private fail(error: Error): void {
    this.failure ??= error
    this.wake(this.failure)
  }

  private wake(error: Error | null): void {
    const resolve = this.waiting
    this.waiting = null
    resolve?.(error)
  }

  /** The next complete reply: "250-…" lines continue, "250 …" ends it. */
  async reply(): Promise<Reply> {
    const started = Date.now()
    const text: string[] = []
    for (;;) {
      const line = this.lines.shift()
      if (line !== undefined) {
        text.push(line.slice(4))
        if (/^\d{3}(?: |$)/.test(line)) return { code: Number(line.slice(0, 3)), text: text.join("\n") }
        continue
      }
      if (this.failure) throw this.failure
      const left = TIMEOUT_MS - (Date.now() - started)
      if (left <= 0) throw new SmtpError("The mail server didn't answer in time")
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiting = null
          resolve()
        }, left)
        this.waiting = (error) => {
          clearTimeout(timer)
          if (error) reject(error)
          else resolve()
        }
      })
    }
  }

  write(data: string): Promise<void> {
    return new Promise((resolve, reject) =>
      this.socket.write(data, (error) => (error ? reject(error) : resolve())),
    )
  }

  /** Send a command and require one of the `expect`ed reply codes. */
  async command(line: string, expect: number[], label = line.split(" ")[0]): Promise<Reply> {
    await this.write(`${line}\r\n`)
    return this.expect(expect, label)
  }

  async expect(codes: number[], label: string): Promise<Reply> {
    const reply = await this.reply()
    if (!codes.includes(reply.code)) {
      throw new SmtpError(`${label} failed: ${reply.code} ${reply.text}`, reply.code)
    }
    return reply
  }

  close(): void {
    this.socket.destroy()
  }
}

function open(config: SmtpConfig): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    const socket: Socket = config.secure
      ? tlsConnect({ host: config.host, port: config.port, servername: config.host }, () => {
          socket.off("error", onError)
          resolve(socket)
        })
      : netConnect({ host: config.host, port: config.port }, () => {
          socket.off("error", onError)
          resolve(socket)
        })
    socket.once("error", onError)
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new SmtpError("Connecting to the mail server timed out")))
  })
}

const b64 = (value: string) => btoa(String.fromCharCode(...new TextEncoder().encode(value)))

/**
 * Send messages over one authenticated session. Returns an error (or null)
 * per message; a connection or login failure throws.
 */
export async function sendMessages(
  config: SmtpConfig,
  messages: MailMessage[],
): Promise<(Error | null)[]> {
  if (messages.length === 0) return []
  if (!config.secure && !LOCAL_HOSTS.includes(config.host)) {
    throw new SmtpError("Refusing to log in to a remote mail server without TLS (use port 465)")
  }
  const smtp = new Connection(await open(config))
  try {
    await smtp.expect([220], "Greeting")
    const ehlo = await smtp.command(`EHLO ${config.host === "localhost" ? "localhost" : "taskly"}`, [250])
    // cPanel's Exim offers PLAIN and LOGIN; prefer PLAIN (one round trip).
    if (/AUTH[ =][^\n]*\bPLAIN\b/i.test(ehlo.text)) {
      await smtp.command(`AUTH PLAIN ${b64(`\u0000${config.user}\u0000${config.pass}`)}`, [235], "AUTH")
    } else {
      await smtp.command("AUTH LOGIN", [334], "AUTH")
      await smtp.command(b64(config.user), [334], "AUTH")
      await smtp.command(b64(config.pass), [235], "AUTH")
    }
    const results: (Error | null)[] = []
    for (const message of messages) {
      try {
        if (/[\s<>]/.test(message.from.email + message.to.email)) {
          throw new SmtpError("Invalid email address")
        }
        await smtp.command(`MAIL FROM:<${message.from.email}>`, [250])
        await smtp.command(`RCPT TO:<${message.to.email}>`, [250, 251])
        await smtp.command("DATA", [354])
        await smtp.write(`${dotStuff(buildMessage(message))}.\r\n`)
        await smtp.expect([250], "DATA")
        results.push(null)
      } catch (error) {
        results.push(error instanceof Error ? error : new Error(String(error)))
        // A refused recipient leaves the session usable; reset and go on.
        await smtp.command("RSET", [250]).catch(() => {})
      }
    }
    await smtp.command("QUIT", [221]).catch(() => {})
    return results
  } finally {
    smtp.close()
  }
}
