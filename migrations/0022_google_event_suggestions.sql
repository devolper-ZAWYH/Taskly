-- Google events an administrator marked as "not a work meeting" for a
-- workspace: not suggested (or added automatically) again.
CREATE TABLE google_event_dismissals (
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  account_id    TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  google_source TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, account_id, google_source)
);

-- A personal calendar whose work meetings (events with someone else from the
-- workspace) are added to this workspace automatically. NULL: off.
ALTER TABLE google_containers ADD COLUMN auto_account_id TEXT REFERENCES accounts (id) ON DELETE SET NULL;

-- One meeting per Google event in a workspace, even if two adds race.
DROP INDEX meetings_google_source;
CREATE UNIQUE INDEX meetings_google_source ON meetings (account_id, google_source)
  WHERE google_source IS NOT NULL;
