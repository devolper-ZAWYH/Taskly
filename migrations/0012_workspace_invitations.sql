-- Adding someone who already has an account invites them: they join only when
-- they accept (from /workspaces). New accounts still join at once and accept
-- by choosing their password (users.invited_at, password_tokens).
CREATE TABLE workspace_invitations (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('administrator', 'member')),
  invited_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (account_id, user_id)
);
CREATE INDEX workspace_invitations_user ON workspace_invitations (user_id);
