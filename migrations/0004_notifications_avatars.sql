-- In-app notifications. Text is rendered at read time from `type` + `data`
-- (JSON) in the reader's current language.
CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  account_id TEXT REFERENCES accounts (id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  data       TEXT NOT NULL,
  link       TEXT,
  -- Which channels this notification was created for (per the user's prefs).
  in_app     INTEGER NOT NULL DEFAULT 1,
  push       INTEGER NOT NULL DEFAULT 0,
  read_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX notifications_user_created ON notifications (user_id, created_at);

-- Per-user, per-type channel switches. A missing row means "on".
CREATE TABLE notification_prefs (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type    TEXT NOT NULL,
  in_app  INTEGER NOT NULL DEFAULT 1,
  push    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, type)
);

-- Browser push endpoints (one per device/browser that opted in).
CREATE TABLE push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);

-- Profile pictures: small square images (resized in the browser), base64.
CREATE TABLE user_avatars (
  user_id      TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  data         TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

ALTER TABLE users ADD COLUMN avatar_updated_at TEXT;
