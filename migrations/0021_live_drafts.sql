-- Draft summary of a live session, mirrored from mcp_drafts (0018): what the
-- summarizer produced, held for 15 minutes under a random handle for the
-- review card (a later phase) to approve into minutes and action items. The
-- table ships now; nothing writes or reads it yet.
CREATE TABLE live_drafts (
  -- The handle the review flow passes back: random and single-use, never a
  -- credential.
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE, -- recorder
  session_id  TEXT NOT NULL REFERENCES live_sessions (id) ON DELETE CASCADE,
  -- JSON: summary, decisions, action_items, follow_ups (fixed sections).
  payload     TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX live_drafts_user ON live_drafts (user_id);
