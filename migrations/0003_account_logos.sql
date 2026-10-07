-- Workspace logos. Small images (≤ 512 KB) stored base64 beside the account;
-- `accounts.logo_updated_at` versions the cached URL so browsers refetch on change.
CREATE TABLE account_logos (
  account_id   TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  data         TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

ALTER TABLE accounts ADD COLUMN logo_updated_at TEXT;
