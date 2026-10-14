-- A third kind of review draft: everything from one meeting at once
-- (review_meeting_outcome). SQLite can't change a CHECK, so the table is made
-- again; drafts last 15 minutes, so none are worth keeping.
DROP TABLE mcp_drafts;
CREATE TABLE mcp_drafts (
  -- The handle Claude passes back: random and single-use, never a credential.
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('delegation', 'meeting', 'outcome')),
  -- JSON: the checked task, meeting or meeting outcome input.
  payload    TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX mcp_drafts_user ON mcp_drafts (user_id);
