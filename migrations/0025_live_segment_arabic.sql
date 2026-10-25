-- Live meetings: each line in both app languages (docs/live-meetings.md §3).
-- The recording device (or the model server it uses) now translates every
-- line both ways: `text_en` already holds the English line, `text_ar` holds
-- the Arabic one, so a reader of either language sees their own first.
ALTER TABLE live_segments ADD COLUMN text_ar TEXT;  -- Arabic line (device-side translate)
