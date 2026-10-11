/**
 * Worker entry: the OpenNext-generated app for HTTP, plus the Cron Triggers:
 * hourly due date reminders, and every 5 minutes Google sync and translation retries.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- the file only exists after a build
// @ts-ignore `.open-next/worker.js` is generated at build time
import { default as handler } from "./.open-next/worker.js"
import type { Ctx } from "@/server/context"
import { runGoogleSync } from "@/server/google/cron"
import { runDueReminders } from "@/server/services/reminders"
import { drainTranslations } from "@/server/translate/service"

export default {
  fetch: handler.fetch,

  async scheduled(controller, env, ctx) {
    // A system context: no session, no cookies.
    const system: Ctx = {
      db: env.DB,
      env,
      token: null,
      setSessionCookie: () => {},
      clearSessionCookie: () => {},
      waitUntil: (promise) => ctx.waitUntil(promise),
    }
    const at = new Date(controller.scheduledTime)
    if (controller.cron === "*/5 * * * *") {
      const ran = await runGoogleSync(system, at)
      if (ran > 0) console.log(`google sync: ${ran} jobs`)
      // Translations that failed earlier (or never got their after-save run).
      const translated = await drainTranslations(system, { limit: 50 })
      if (translated > 0) console.log(`translations: ${translated} ran`)
      return
    }
    const sent = await runDueReminders(system, at)
    console.log(`due date reminders: ${sent} sent`)
  },
} satisfies ExportedHandler<CloudflareEnv>
