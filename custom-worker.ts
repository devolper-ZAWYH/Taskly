/**
 * Worker entry: the OpenNext-generated app for HTTP, plus the hourly Cron
 * Trigger that sends due date reminders.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- the file only exists after a build
// @ts-ignore `.open-next/worker.js` is generated at build time
import { default as handler } from "./.open-next/worker.js"
import type { Ctx } from "@/server/context"
import { runDueReminders } from "@/server/services/reminders"

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
    const sent = await runDueReminders(system, new Date(controller.scheduledTime))
    console.log(`due date reminders: ${sent} sent`)
  },
} satisfies ExportedHandler<CloudflareEnv>
