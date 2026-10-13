-- Reviews for Claude's write actions (docs/plan-claude-connector.md §5).
-- Giving a task to other people and creating a meeting only work with a
-- draft that the review step issued, for the same person, within 15 minutes,
-- so Claude can't skip the review.
CREATE TABLE mcp_drafts (
  -- The handle Claude passes back: random and single-use, never a credential.
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('delegation', 'meeting')),
  -- JSON: the checked task or meeting input.
  payload    TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX mcp_drafts_user ON mcp_drafts (user_id);
