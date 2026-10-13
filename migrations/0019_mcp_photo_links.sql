-- Profile pictures in Claude's interactive cards (docs/plan-claude-connector.md
-- §11, phase 3). A card runs on Claude's own domain without the person's
-- Taskly cookie, so the photos it shows carry a short-lived link token. The
-- token lets its holder see photos only, exactly the ones the person could
-- see in Taskly, for an hour, and stops working when Claude is disconnected.
CREATE TABLE mcp_photo_links (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  grant_id   TEXT NOT NULL REFERENCES oauth_grants (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE INDEX mcp_photo_links_user ON mcp_photo_links (user_id);
