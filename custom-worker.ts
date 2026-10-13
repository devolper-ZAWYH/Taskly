/**
 * Worker entry: the OpenNext-generated app for HTTP, plus the Cron Triggers:
 * hourly due date reminders, and every 5 minutes Google sync and translation retries.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- the file only exists after a build
// @ts-ignore `.open-next/worker.js` is generated at build time
import { default as handler } from "./.open-next/worker.js"
import { runJobs, systemContext } from "@/server/jobs"

export default {
  fetch: handler.fetch,

  async scheduled(controller, env, ctx) {
    const system = systemContext(env, (promise) => ctx.waitUntil(promise))
    const kind = controller.cron === "*/5 * * * *" ? "frequent" : "hourly"
    console.log(await runJobs(system, kind, new Date(controller.scheduledTime)))
  },
} satisfies ExportedHandler<CloudflareEnv>
