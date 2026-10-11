/**
 * Arabic ↔ English translation of what people write: a meeting's title and
 * agenda are saved in both languages. Saving queues the work (rows in
 * `translations`); it runs right after the response and again from the
 * 5-minute cron, with backoff. The provider comes from Platform → Settings.
 */
import type { FieldTranslation } from "@/lib/types"
import type { Ctx } from "@/server/context"
import { all, first, nowIso, run } from "@/server/db"
import { translatorFor } from "@/server/translate/providers"
import { detectLang, hashText, otherLang, translateText, type Lang } from "@/server/translate/text"

type Kind = "meeting"

/** The fields each kind of item translates, and how to read their current text. */
const SOURCES: Record<Kind, { fields: string[]; load: (ctx: Ctx, id: string) => Promise<Record<string, string> | null> }> = {
  meeting: {
    fields: ["title", "notes"],
    load: (ctx, id) =>
      first<Record<string, string>>(ctx.db, "SELECT title, notes FROM meetings WHERE id = ?", id),
  },
}

type Row = {
  entity_kind: Kind
  entity_id: string
  field: string
  source_lang: Lang
  target_lang: Lang
  source_hash: string
  text: string
  status: "pending" | "done" | "failed"
  attempts: number
}

/** Retry after 1 m, 5 m, 30 m and 2 h; then the row stays failed until someone retries it. */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000]

/**
 * After an item was saved: make sure each field has an up-to-date translation
 * queued (or none, when it's empty or has no words). A no-op without a provider.
 */
export async function queueTranslations(ctx: Ctx, kind: Kind, id: string): Promise<void> {
  if (!(await translatorFor(ctx))) return
  const source = await SOURCES[kind].load(ctx, id)
  if (!source) return
  const existing = await all<Row>(
    ctx.db,
    "SELECT * FROM translations WHERE entity_kind = ? AND entity_id = ?",
    kind,
    id,
  )
  const now = nowIso()
  const statements: D1PreparedStatement[] = []
  for (const field of SOURCES[kind].fields) {
    const text = (source[field] ?? "").trim()
    const lang = text ? detectLang(text) : null
    if (!lang) {
      statements.push(
        ctx.db
          .prepare("DELETE FROM translations WHERE entity_kind = ? AND entity_id = ? AND field = ?")
          .bind(kind, id, field),
      )
      continue
    }
    const hash = await hashText(text)
    const row = existing.find((r) => r.field === field)
    if (row && row.source_hash === hash && row.status !== "failed") continue
    statements.push(
      ctx.db
        .prepare(
          `INSERT INTO translations (entity_kind, entity_id, field, source_lang, target_lang,
             source_hash, text, status, attempts, next_attempt_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, '', 'pending', 0, ?, ?)
           ON CONFLICT (entity_kind, entity_id, field) DO UPDATE SET
             source_lang = excluded.source_lang, target_lang = excluded.target_lang,
             source_hash = excluded.source_hash, status = 'pending', attempts = 0,
             next_attempt_at = excluded.next_attempt_at, last_error = NULL,
             updated_at = excluded.updated_at`,
        )
        .bind(kind, id, field, lang, otherLang(lang), hash, now, now),
    )
  }
  if (statements.length === 0) return
  await ctx.db.batch(statements)
  ctx.waitUntil(drainTranslations(ctx).catch((error) => console.error("translation failed", error)))
}

/** Forget an item's translations (it was deleted). */
export function forgetTranslations(ctx: Ctx, kind: Kind, id: string): Promise<void> {
  return run(ctx.db, "DELETE FROM translations WHERE entity_kind = ? AND entity_id = ?", kind, id)
}

/** Put an item's failed (or all) translations back in the queue and run them. */
export async function retryTranslations(ctx: Ctx, kind: Kind, id: string): Promise<void> {
  await run(
    ctx.db,
    `UPDATE translations SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL
     WHERE entity_kind = ? AND entity_id = ?`,
    nowIso(),
    kind,
    id,
  )
  await queueTranslations(ctx, kind, id)
  await drainTranslations(ctx, { limit: 5 })
}

/** Run due translations until `limit` ran or `budgetMs` passed. Returns how many ran. */
export async function drainTranslations(
  ctx: Ctx,
  { limit = 20, budgetMs = 20_000 }: { limit?: number; budgetMs?: number } = {},
): Promise<number> {
  const translator = await translatorFor(ctx)
  if (!translator) return 0
  const started = Date.now()
  const rows = await all<Row>(
    ctx.db,
    `SELECT * FROM translations WHERE status = 'pending' AND next_attempt_at <= ?
     ORDER BY next_attempt_at LIMIT ?`,
    nowIso(),
    limit,
  )
  let ran = 0
  for (const row of rows) {
    if (Date.now() - started > budgetMs) break
    ran++
    const source = await SOURCES[row.entity_kind].load(ctx, row.entity_id)
    const text = (source?.[row.field] ?? "").trim()
    if (!source || !text) {
      await run(
        ctx.db,
        "DELETE FROM translations WHERE entity_kind = ? AND entity_id = ? AND field = ?",
        row.entity_kind,
        row.entity_id,
        row.field,
      )
      continue
    }
    // Edited since it was queued: the newer queue entry handles it.
    if ((await hashText(text)) !== row.source_hash) continue
    try {
      const translated = await translateText(translator, text, row.source_lang, row.target_lang)
      await run(
        ctx.db,
        `UPDATE translations SET text = ?, status = 'done', provider = ?, last_error = NULL, updated_at = ?
         WHERE entity_kind = ? AND entity_id = ? AND field = ? AND source_hash = ?`,
        translated,
        translator.name,
        nowIso(),
        row.entity_kind,
        row.entity_id,
        row.field,
        row.source_hash,
      )
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
      const attempts = row.attempts + 1
      const delay = BACKOFF_MS[attempts - 1]
      console.error(`translation ${row.entity_kind}/${row.field} failed (attempt ${attempts}): ${message}`)
      await run(
        ctx.db,
        `UPDATE translations SET attempts = ?, last_error = ?, status = ?, next_attempt_at = ?, updated_at = ?
         WHERE entity_kind = ? AND entity_id = ? AND field = ? AND source_hash = ?`,
        attempts,
        message,
        delay === undefined ? "failed" : "pending",
        new Date(Date.now() + (delay ?? 0)).toISOString(),
        nowIso(),
        row.entity_kind,
        row.entity_id,
        row.field,
        row.source_hash,
      )
    }
  }
  return ran
}

/** An item's translations by field, for reading it. */
export async function translationsOf(
  ctx: Ctx,
  kind: Kind,
  id: string,
): Promise<Record<string, FieldTranslation>> {
  const rows = await all<Row>(
    ctx.db,
    "SELECT * FROM translations WHERE entity_kind = ? AND entity_id = ?",
    kind,
    id,
  )
  return Object.fromEntries(
    rows.map((row) => [
      row.field,
      { from: row.source_lang, lang: row.target_lang, text: row.text, status: row.status },
    ]),
  )
}
