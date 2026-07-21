CREATE TABLE write_proposals (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  agent_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  before_json TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  record_version TEXT NOT NULL,
  capability_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE INDEX write_proposals_expiry_idx
  ON write_proposals (expires_at);
