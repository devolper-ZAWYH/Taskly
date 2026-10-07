-- The person's IANA time zone (reported by their browser) so reminders arrive
-- at a sensible local hour. NULL until first reported; treated as UTC.
ALTER TABLE users ADD COLUMN timezone TEXT;

-- One row per reminder sent, so the hourly job never repeats one — even if a
-- cron run is retried. A changed due date allows fresh reminders.
CREATE TABLE task_reminders (
  task_id  TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind     TEXT NOT NULL,
  due_date TEXT NOT NULL,
  sent_at  TEXT NOT NULL,
  PRIMARY KEY (task_id, user_id, kind, due_date)
);
