PRAGMA foreign_keys = ON;

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  ticket_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX conversations_ticket_idx
  ON conversations (tenant_key, ticket_id, updated_at DESC);
CREATE INDEX conversations_expiry_idx
  ON conversations (expires_at);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  agent_id INTEGER,
  agent_name TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX messages_conversation_idx
  ON messages (conversation_id, created_at);

CREATE TABLE tool_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  skill_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  request_summary_json TEXT NOT NULL,
  result_summary_json TEXT,
  safe_error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX tool_runs_conversation_idx
  ON tool_runs (conversation_id, created_at);

CREATE TABLE pending_turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX pending_turns_expiry_idx
  ON pending_turns (expires_at);
