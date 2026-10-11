-- Private tasks: anyone can create a task for themselves that only they can
-- see (administrators included). Their creator is their only assignee.
ALTER TABLE tasks ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
-- Private tasks only: whether a copy goes to the owner's Google Tasks.
-- Shared tasks always sync for assignees who connected Google.
ALTER TABLE tasks ADD COLUMN google_sync INTEGER NOT NULL DEFAULT 0;
CREATE INDEX tasks_private_owner ON tasks (account_id, created_by_id) WHERE private = 1;
