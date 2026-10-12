-- Meeting minutes: each person's own notes on a meeting, one set per person per
-- meeting. The author chooses who reads them: only themselves ('private'),
-- everyone in the workspace ('workspace'), or selected people ('people', listed
-- in meeting_minutes_shares). Only the author edits or deletes them.
CREATE TABLE meeting_minutes (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- NULL once the meeting is deleted: minutes outlive their meeting.
  meeting_id    TEXT REFERENCES meetings (id) ON DELETE SET NULL,
  -- The meeting's title and date as last known, shown after it's deleted.
  meeting_title TEXT NOT NULL,
  meeting_date  TEXT NOT NULL,
  author_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  visibility    TEXT NOT NULL CHECK (visibility IN ('private', 'workspace', 'people')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX meeting_minutes_author ON meeting_minutes (meeting_id, author_id);
CREATE INDEX meeting_minutes_account ON meeting_minutes (account_id, meeting_date);

CREATE TABLE meeting_minutes_shares (
  minutes_id TEXT NOT NULL REFERENCES meeting_minutes (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (minutes_id, user_id)
);
CREATE INDEX meeting_minutes_shares_user ON meeting_minutes_shares (user_id);
