-- Machine translation between Arabic and English (server/translate): whatever
-- someone writes in one language is saved in the other too. One row per
-- translated field (the target is the other language); the rows double as
-- the work queue. The provider is chosen in Platform → Settings.
CREATE TABLE translations (
  entity_kind     TEXT NOT NULL CHECK (entity_kind IN ('meeting')),
  entity_id       TEXT NOT NULL,
  field           TEXT NOT NULL,
  source_lang     TEXT NOT NULL CHECK (source_lang IN ('en', 'ar')),
  target_lang     TEXT NOT NULL CHECK (target_lang IN ('en', 'ar')),
  -- SHA-256 of the text it was made from; a stale result is never saved.
  source_hash     TEXT NOT NULL,
  text            TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
  provider        TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error      TEXT,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (entity_kind, entity_id, field)
);
CREATE INDEX translations_due ON translations (status, next_attempt_at);
