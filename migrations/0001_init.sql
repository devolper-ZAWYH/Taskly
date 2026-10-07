-- Initial schema: users, workspaces (accounts) with per-workspace roles,
-- tasks, meetings, and sign-in sessions. Timestamps are ISO-8601 strings;
-- dates are `YYYY-MM-DD` and times `HH:MM` ("" when unset).

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_operator   INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  locale        TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'ar')),
  created_at    TEXT NOT NULL
);

CREATE TABLE accounts (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  -- Last T-n number handed out; never reused, even after deletes.
  task_counter INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE TABLE memberships (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('administrator', 'member')),
  created_at TEXT NOT NULL,
  UNIQUE (account_id, user_id)
);
CREATE INDEX memberships_user ON memberships (user_id);

CREATE TABLE meetings (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  notes        TEXT NOT NULL DEFAULT '',
  date         TEXT NOT NULL,
  start_time   TEXT NOT NULL,
  end_time     TEXT NOT NULL,
  location     TEXT NOT NULL DEFAULT '',
  organizer_id TEXT NOT NULL REFERENCES users (id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX meetings_account_date ON meetings (account_id, date);

CREATE TABLE meeting_attendees (
  meeting_id TEXT NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, user_id)
);
CREATE INDEX meeting_attendees_user ON meeting_attendees (user_id);

CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  number        INTEGER NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL
    CHECK (status IN ('open', 'in_progress', 'on_hold', 'completed', 'cancelled')),
  priority      TEXT NOT NULL CHECK (priority IN ('none', 'low', 'medium', 'high', 'urgent')),
  start_date    TEXT NOT NULL DEFAULT '',
  start_time    TEXT NOT NULL DEFAULT '',
  due_date      TEXT NOT NULL DEFAULT '',
  due_time      TEXT NOT NULL DEFAULT '',
  created_by_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  meeting_id    TEXT REFERENCES meetings (id) ON DELETE SET NULL,
  completed_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (account_id, number)
);
CREATE INDEX tasks_account_due ON tasks (account_id, due_date);
CREATE INDEX tasks_meeting ON tasks (meeting_id);

CREATE TABLE task_assignees (
  task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, user_id)
);
CREATE INDEX task_assignees_user ON task_assignees (user_id);

-- The cookie holds a random token; only its SHA-256 is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
