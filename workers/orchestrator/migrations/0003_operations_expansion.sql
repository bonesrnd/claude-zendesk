CREATE TABLE shipstation_phone_cache (
  phone_hash TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  incomplete INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX shipstation_phone_cache_expiry_idx
  ON shipstation_phone_cache (expires_at);
