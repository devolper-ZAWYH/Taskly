-- Live meetings (docs/live-meetings.md): a recording session creates one row
-- per device push, with segments keyed per (session, seq) so pushes are
-- idempotent. The Cloudflare and cPanel builds share this schema.
--
-- Device tokens are per (user, workspace): the token opens only sessions the
-- same person recorded in the same workspace, hashed like session tokens
-- (`server/crypto.ts`) and shown to the person exactly once in Settings.

CREATE TABLE live_sessions (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- NULL for an ad-hoc recording (nothing claimed a meeting). Kept as a
  -- reference after the meeting is deleted, like meeting minutes do.
  meeting_id    TEXT REFERENCES meetings (id) ON DELETE SET NULL,
  -- The meeting's title and date as last known, shown when it's deleted.
  -- Firestore-style snapshots: the device's claim of a meeting copies them.
  meeting_title TEXT NOT NULL,
  meeting_date  TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE, -- recorder
  status        TEXT NOT NULL CHECK (status IN ('capturing','reviewing','done','aborted')),
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  -- The recorder's last contact (every push updates it); the retention job
  -- (later phase) aborts sessions whose recorder went silent.
  last_seen_at  TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX live_sessions_account ON live_sessions (account_id, started_at);
CREATE INDEX live_sessions_recorder ON live_sessions (user_id);

CREATE TABLE live_segments (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES live_sessions (id) ON DELETE CASCADE,
  -- Per session, monotonic from 1: the idempotent push key. A repeated
  -- (session_id, seq) is ACK'd without rewriting the stored row.
  seq        INTEGER NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('mic','system')),
  lang       TEXT,                      -- 'ar' | 'en' | … as spoken (auto)
  text       TEXT NOT NULL,             -- original language
  text_en    TEXT,                      -- English line (device-side translate)
  -- Utterance clock in milliseconds from the session start, as TEXT (the
  -- device's own offsets; the panel shows order, not a clock).
  started_at TEXT,
  ended_at   TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, seq)
);
CREATE INDEX live_segments_session ON live_segments (session_id, seq);

CREATE TABLE live_device_tokens (
  id         TEXT PRIMARY KEY,
  -- The workspace the device records into; rejecting is per (user, workspace).
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,             -- "Dell XPS", "Studio PC"
  token_hash TEXT NOT NULL,             -- SHA-256, like session tokens
  last_used  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- Set on revoke: future pushes are refused (403); the row stays so a
  -- re-tokened device doesn't collide, and nothing recorded is lost.
  revoked_at TEXT
);
CREATE UNIQUE INDEX live_device_tokens_hash ON live_device_tokens (token_hash);
CREATE INDEX live_device_tokens_user ON live_device_tokens (user_id);
