-- Taskly as a Claude connector (docs/plan-claude-connector.md). Taskly is the
-- OAuth 2.1 authorization server for its own MCP endpoint (/mcp). Codes and
-- tokens are stored only as SHA-256 hashes, like sessions.

-- Apps that may ask for access. `cimd`: the client_id is an https URL whose
-- metadata document we fetched (Claude's own). `dcr`: registered through
-- /oauth/register (older clients).
CREATE TABLE oauth_clients (
  client_id     TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('cimd', 'dcr')),
  name          TEXT NOT NULL DEFAULT '',
  -- JSON array of the redirect URIs the client registered.
  redirect_uris TEXT NOT NULL,
  -- `cimd`: when the document was last read (re-read after a day).
  fetched_at    TEXT,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);

-- One-time authorization codes, exchanged within 60 seconds.
CREATE TABLE oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope          TEXT NOT NULL,
  resource       TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);

-- A person's permission for one app: a "connection" in Settings → Set up MCP.
CREATE TABLE oauth_grants (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  client_id    TEXT NOT NULL,
  -- What the person saw on the consent screen, kept for the connection list.
  client_name  TEXT NOT NULL DEFAULT '',
  client_host  TEXT NOT NULL DEFAULT '',
  scope        TEXT NOT NULL,
  resource     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);
CREATE INDEX oauth_grants_user ON oauth_grants (user_id);

-- Access tokens (1 hour) and refresh tokens (60 days, rotated on every use).
CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id   TEXT NOT NULL REFERENCES oauth_grants (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  -- Space-separated; at most the grant's scope (a refresh may narrow it).
  scope      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  -- Refresh tokens: when it was exchanged. Using it again revokes the grant.
  used_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX oauth_tokens_grant ON oauth_tokens (grant_id);
