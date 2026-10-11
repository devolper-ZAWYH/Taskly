-- Transactional email (server/mail): notification emails and invitations.

-- Email is a third notification channel, off unless the person turns it on.
ALTER TABLE notification_prefs ADD COLUMN email INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notifications ADD COLUMN email INTEGER NOT NULL DEFAULT 0;

-- Set while someone added by email hasn't accepted their invitation (chosen
-- a password) yet; cleared when they do.
ALTER TABLE users ADD COLUMN invited_at TEXT;

-- One-time links to set a password: invitations and "Forgot password?"
-- resets. Only a hash of the token is stored.
CREATE TABLE password_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('invite', 'reset')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX password_tokens_user ON password_tokens (user_id);
