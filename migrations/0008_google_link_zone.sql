-- The time zone a meeting's Google copy was last written in. Reading the copy
-- back in that zone (not today's workspace or organiser zone) keeps a zone
-- change from looking like someone moved the event in Google.
ALTER TABLE google_links ADD COLUMN zone TEXT;
