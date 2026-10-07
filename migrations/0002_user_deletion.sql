-- Deleting a user keeps an anonymized row (name, email and password wiped,
-- `deleted_at` set) so tasks and meetings that point at them stay valid.
ALTER TABLE users ADD COLUMN deleted_at TEXT;
