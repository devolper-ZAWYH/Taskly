-- Two-way Google Calendar + Google Tasks sync (docs/plan-google-sync.md).
-- Workspace tasks/meetings are copied into each connected person's
-- "Taskly · <Workspace>" task list and calendar; their own Google items are
-- read and written live, so nothing of theirs is stored here.

-- One Google account per person. Tokens are AES-GCM encrypted (GOOGLE_TOKEN_KEY).
CREATE TABLE google_connections (
  user_id           TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  google_sub        TEXT NOT NULL,
  google_email      TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  access_token_enc  TEXT,
  access_expires_at TEXT,
  scopes            TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked', 'error')),
  last_error        TEXT,
  last_sync_at      TEXT,
  -- Last time they opened Taskly: active people are polled more often.
  last_seen_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- Task lists and calendars Taskly knows about, per person.
-- account_id set  = the "Taskly · <Workspace>" container Taskly created and syncs.
-- account_id NULL = one of the person's own; `selected` shows it in Taskly.
CREATE TABLE google_containers (
  user_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('tasklist', 'calendar')),
  google_id           TEXT NOT NULL,
  account_id          TEXT REFERENCES accounts (id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  color               TEXT,
  -- Calendars: Google's accessRole (owner / writer / reader / freeBusyReader).
  access_role         TEXT,
  is_primary          INTEGER NOT NULL DEFAULT 0,
  selected            INTEGER NOT NULL DEFAULT 0,
  -- Calendars: events.list syncToken. Task lists: updatedMin cursor (ISO).
  sync_token          TEXT,
  polled_at           TEXT,
  -- Calendar push channel (events.watch), when the app has a public URL.
  channel_id          TEXT,
  channel_token       TEXT,
  channel_resource_id TEXT,
  channel_expires_at  TEXT,
  PRIMARY KEY (user_id, kind, google_id)
);
CREATE UNIQUE INDEX google_containers_workspace
  ON google_containers (user_id, kind, account_id) WHERE account_id IS NOT NULL;
CREATE UNIQUE INDEX google_containers_channel
  ON google_containers (channel_id) WHERE channel_id IS NOT NULL;

-- Which Google copy mirrors which workspace task/meeting, for whom. No foreign
-- key to the item: after it is deleted, the link is how its copies get removed.
CREATE TABLE google_links (
  kind         TEXT NOT NULL CHECK (kind IN ('task', 'meeting')),
  entity_id    TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  account_id   TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  container_id TEXT NOT NULL,
  google_id    TEXT NOT NULL,
  etag         TEXT,
  -- JSON of the two-way fields as both sides last agreed (three-way merge base).
  base         TEXT NOT NULL,
  -- Taskly's footer as last written, so footer-only changes still get pushed.
  footer       TEXT NOT NULL DEFAULT '',
  synced_at    TEXT NOT NULL,
  PRIMARY KEY (kind, entity_id, user_id)
);
CREATE UNIQUE INDEX google_links_google ON google_links (user_id, google_id);
CREATE INDEX google_links_account ON google_links (user_id, account_id);

-- Outbox: every Google side effect is a job, retried with backoff. Queuing the
-- same work again bumps `version` instead of adding a row, and a job is only
-- removed if nothing re-queued it while it ran.
CREATE TABLE google_sync_jobs (
  id              TEXT PRIMARY KEY,
  dedupe_key      TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL,
  user_id         TEXT,
  account_id      TEXT,
  entity_id       TEXT,
  version         INTEGER NOT NULL DEFAULT 1,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  locked_until    TEXT,
  last_error      TEXT,
  failed_at       TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX google_sync_jobs_due ON google_sync_jobs (failed_at, next_attempt_at);

-- The workspace's time zone for Google events (NULL: the organiser's, then UTC).
ALTER TABLE accounts ADD COLUMN timezone TEXT;
