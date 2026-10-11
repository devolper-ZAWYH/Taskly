-- Failed sign-ins, to slow down password guessing (server/services/auth.ts):
-- per email address and per network address, over a 15-minute window.
CREATE TABLE login_failures (
  -- "email:<address>" or "ip:<address>"
  key       TEXT NOT NULL,
  failed_at TEXT NOT NULL
);
CREATE INDEX login_failures_key ON login_failures (key, failed_at);
