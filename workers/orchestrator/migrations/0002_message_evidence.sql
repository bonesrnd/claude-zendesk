ALTER TABLE messages
  ADD COLUMN citations_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE messages
  ADD COLUMN tool_events_json TEXT NOT NULL DEFAULT '[]';
