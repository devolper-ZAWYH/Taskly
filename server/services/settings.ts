/**
 * Platform → Settings (operators): the deployment's address, email, Google
 * client and push keys, stored per group in `platform_settings`
 * (server/settings.ts). Secrets go in encrypted and never come back out.
 */
import { AppError } from "@/lib/api/core"
import type { PlatformSettings, PlatformSettingsInput } from "@/lib/types"
import { requireOperator, type Ctx } from "@/server/context"
import { first, run } from "@/server/db"
import { mailConfig, parseFrom } from "@/server/mail/config"
import { sendMessages } from "@/server/mail/smtp"
import { plainMail } from "@/server/mail/templates"
import {
  appOrigin,
  clearGroup,
  encryptionKey,
  saveGroup,
  SETTING_GROUPS,
  settingsOf,
  type SettingGroup,
} from "@/server/settings"
import { assertEmail, bool, int, isObject, oneOf, str } from "@/server/validate"

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"]

export async function getPlatformSettings(ctx: Ctx): Promise<PlatformSettings> {
  await requireOperator(ctx)
  return view(ctx)
}

async function view(ctx: Ctx): Promise<PlatformSettings> {
  const resolved = await settingsOf(ctx)
  const { values, sources } = resolved
  const mail = mailConfig(resolved)
  const origin = (values.app_origin ?? "").replace(/\/$/, "")
  const devices = await first<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM push_subscriptions")
  const ready = Boolean(encryptionKey(ctx.env))
  return {
    encryptionReady: ready,
    app: { source: sources.app, origin },
    mail: {
      source: sources.mail,
      host: values.smtp_host ?? "",
      port: Number(values.smtp_port) || 465,
      secure: mail?.secure ?? true,
      user: values.smtp_user ?? "",
      from: values.mail_from ?? "",
      passwordSet: Boolean(values.smtp_pass),
      ready: mail !== null,
    },
    google: {
      source: sources.google,
      clientId: values.google_client_id ?? "",
      secretSet: Boolean(values.google_client_secret),
      redirectUri: origin ? `${origin}/api/google/callback` : "",
      ready: Boolean(values.google_client_id && values.google_client_secret && ready),
    },
    push: {
      source: sources.push,
      publicKey: values.vapid_public_key ?? "",
      ready: Boolean(values.vapid_public_key && values.vapid_private_key),
      devices: devices?.n ?? 0,
    },
  }
}

/** `http(s)://host[:port]` only (no path), as the app's public address. */
function originOf(value: unknown): string {
  try {
    const url = new URL(str(value, 300).trim())
    if (!["http:", "https:"].includes(url.protocol) || url.pathname.length > 1 || url.search) {
      throw new Error()
    }
    return url.origin
  } catch {
    throw new AppError("invalidUrl")
  }
}

function settingsInput(value: unknown): PlatformSettingsInput {
  if (!isObject(value)) throw new AppError("badRequest")
  const group = oneOf(value.group, ["app", "mail", "google"] as const)
  if (group === "app") return { group, origin: originOf(value.origin) }
  if (group === "google") {
    return {
      group,
      clientId: str(value.clientId, 300).trim(),
      clientSecret: str(value.clientSecret, 300).trim(),
    }
  }
  return {
    group,
    host: str(value.host, 253).trim(),
    port: int(value.port, 1, 65535),
    secure: bool(value.secure),
    user: str(value.user, 254).trim(),
    from: str(value.from, 300).trim(),
    password: str(value.password, 500),
  }
}

/** Save one group (it then overrides the environment). */
export async function savePlatformSettings(ctx: Ctx, raw: unknown): Promise<PlatformSettings> {
  const me = await requireOperator(ctx)
  const input = settingsInput(raw)
  const current = (await settingsOf(ctx)).values
  if (input.group === "app") {
    await saveGroup(ctx, "app", { app_origin: input.origin }, me.id)
    return view(ctx)
  }
  if (!encryptionKey(ctx.env)) throw new AppError("encryptionKeyMissing")
  if (input.group === "google") {
    if (!input.clientId) throw new AppError("badRequest")
    // An empty secret keeps the one in use (from here or the environment).
    const secret = input.clientSecret || current.google_client_secret
    if (!secret) throw new AppError("secretRequired")
    await saveGroup(
      ctx,
      "google",
      { google_client_id: input.clientId, google_client_secret: secret },
      me.id,
    )
    return view(ctx)
  }
  if (!/^[a-z0-9.-]+$/i.test(input.host) || !input.user) throw new AppError("badRequest")
  // Never send the mailbox password over the network unencrypted.
  if (!input.secure && !LOCAL_HOSTS.includes(input.host)) throw new AppError("smtpInsecure")
  const from = parseFrom(input.from, input.user)
  assertEmail(from.email)
  const password = input.password || current.smtp_pass
  if (!password) throw new AppError("secretRequired")
  await saveGroup(
    ctx,
    "mail",
    {
      smtp_host: input.host,
      smtp_port: String(input.port),
      smtp_secure: input.secure ? "true" : "false",
      smtp_user: input.user,
      smtp_pass: password,
      mail_from: input.from,
    },
    me.id,
  )
  return view(ctx)
}

/** Forget a group's console values: it falls back to the environment. */
export async function resetPlatformSettings(ctx: Ctx, group: unknown): Promise<PlatformSettings> {
  await requireOperator(ctx)
  await clearGroup(ctx, oneOf<SettingGroup>(group, SETTING_GROUPS))
  return view(ctx)
}

/**
 * Send a test email to the operator with the current settings. Returns the
 * mail server's answer instead of throwing, so the operator sees what's wrong.
 */
export async function sendTestEmail(ctx: Ctx): Promise<{ ok: boolean; error: string | null }> {
  const me = await requireOperator(ctx)
  const config = mailConfig(await settingsOf(ctx))
  if (!config) throw new AppError("mailNotConfigured")
  const mail = plainMail(me.locale, {
    subject: { en: "Taskly test email", ar: "رسالة تجريبية من Taskly" },
    text: {
      en: "This is a test email from Taskly. Email is working.",
      ar: "هذه رسالة تجريبية من Taskly. البريد الإلكتروني يعمل.",
    },
    origin: await appOrigin(ctx),
  })
  try {
    const [error] = await sendMessages(config, [
      { from: config.from, to: { name: me.name, email: me.email }, ...mail },
    ])
    return { ok: !error, error: error?.message ?? null }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

const base64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

/**
 * New push key pair. Devices subscribed with the old key can't receive pushes
 * any more, so their subscriptions are dropped; people turn push on again.
 */
export async function generatePushKeys(ctx: Ctx): Promise<PlatformSettings> {
  const me = await requireOperator(ctx)
  if (!encryptionKey(ctx.env)) throw new AppError("encryptionKeyMissing")
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair
  const publicKey = base64url((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer)
  const { d } = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey
  if (!d) throw new Error("Couldn't export the push key")
  await saveGroup(ctx, "push", { vapid_public_key: publicKey, vapid_private_key: d }, me.id)
  await run(ctx.db, "DELETE FROM push_subscriptions")
  return view(ctx)
}

