-- A meeting an administrator added to the workspace from a Google Calendar
-- event: "<iCalUID>#<original start>" of that event. Everyone who can see the
-- meeting stops seeing the original among their own Google events in Taskly.
ALTER TABLE meetings ADD COLUMN google_source TEXT;
CREATE INDEX meetings_google_source ON meetings (google_source) WHERE google_source IS NOT NULL;
