/** Platform → Settings (operators): this deployment's address, email, Google client and push keys. */
import { rpc } from "@/lib/api/rpc"
import type { PlatformSettings, PlatformSettingsInput } from "@/lib/types"

export const getPlatformSettings = (): Promise<PlatformSettings> => rpc("getPlatformSettings")

/** Save one group; an empty secret keeps the current one. */
export const savePlatformSettings = (input: PlatformSettingsInput): Promise<PlatformSettings> =>
  rpc("savePlatformSettings", input)

/** Drop a group's saved values so the server environment applies again. */
export const resetPlatformSettings = (
  group: "app" | "mail" | "google" | "push",
): Promise<PlatformSettings> => rpc("resetPlatformSettings", group)

/** Emails the signed-in operator; `error` is the mail server's answer when it fails. */
export const sendTestEmail = (): Promise<{ ok: boolean; error: string | null }> =>
  rpc("sendTestEmail")

/** New push key pair (existing push subscriptions stop working). */
export const generatePushKeys = (): Promise<PlatformSettings> => rpc("generatePushKeys")
