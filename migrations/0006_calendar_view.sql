-- How the calendar opens on a phone: "calendar" (month grid) or "list".
-- Saved per person so the choice follows them across visits and devices.
ALTER TABLE users ADD COLUMN calendar_view TEXT NOT NULL DEFAULT 'calendar';
