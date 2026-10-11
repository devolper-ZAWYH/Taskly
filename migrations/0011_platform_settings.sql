-- Deployment settings edited in Platform → Settings (server/settings.ts), so
-- one build serves every deployment without redeploying: the app's address,
-- email (SMTP), the Google OAuth client and the push key pair. A group saved
-- here replaces the environment's values; secrets are AES-GCM encrypted with
-- the ENCRYPTION_KEY secret.
CREATE TABLE platform_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users (id) ON DELETE SET NULL
);
