-- More than one email per person: one login across workspaces that each know
-- them by a different address. users.email stays the primary address; these
-- are the others. Only confirmed ones (verified_at set) sign in, receive
-- invitations and password resets, or count as taken; until then the
-- confirmation link's hash sits on the row.
CREATE TABLE user_emails (
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  email            TEXT NOT NULL,
  verified_at      TEXT,
  token_hash       TEXT,
  token_expires_at TEXT,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, email)
);
CREATE UNIQUE INDEX user_emails_verified ON user_emails (email) WHERE verified_at IS NOT NULL;
CREATE UNIQUE INDEX user_emails_token ON user_emails (token_hash) WHERE token_hash IS NOT NULL;

-- Confirmation emails sent, per person: rate limits, so "add address" can't be
-- used to send mail to strangers. Kept for a day.
CREATE TABLE email_confirmation_sends (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  sent_at TEXT NOT NULL
);
CREATE INDEX email_confirmation_sends_user ON email_confirmation_sends (user_id, sent_at);

-- The address a workspace knows each member by (NULL: their primary). Its
-- Members page shows it and its notification emails go there.
ALTER TABLE memberships ADD COLUMN email TEXT;
-- The address an invitation was sent to; it becomes the membership's address.
ALTER TABLE workspace_invitations ADD COLUMN email TEXT;
