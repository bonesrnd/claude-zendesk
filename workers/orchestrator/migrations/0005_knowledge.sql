CREATE TABLE knowledge_documents (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  active_version_id TEXT
    REFERENCES knowledge_versions(id) ON DELETE SET NULL,
  pending_version_id TEXT
    REFERENCES knowledge_versions(id) ON DELETE SET NULL,
  deletion_status TEXT
    CHECK (deletion_status IS NULL OR deletion_status IN ('deleting', 'delete_failed')),
  deletion_error TEXT,
  delete_attempts INTEGER NOT NULL DEFAULT 0
    CHECK (delete_attempts >= 0),
  delete_updated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE knowledge_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL
    REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  expected_active_version_id TEXT,
  candidate_r2_key TEXT NOT NULL UNIQUE,
  r2_key TEXT NOT NULL UNIQUE,
  content_sha256 TEXT NOT NULL
    CHECK (length(content_sha256) = 64),
  status TEXT NOT NULL
    CHECK (status IN ('queued', 'indexing', 'ready', 'active', 'superseded', 'failed')),
  chunk_count INTEGER NOT NULL
    CHECK (chunk_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX knowledge_versions_document_status_idx
  ON knowledge_versions (document_id, status, updated_at DESC);

CREATE TABLE knowledge_chunks (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL
    REFERENCES knowledge_versions(id) ON DELETE CASCADE,
  heading_path TEXT NOT NULL,
  ordinal INTEGER NOT NULL
    CHECK (ordinal >= 0),
  content TEXT NOT NULL,
  vector_id TEXT NOT NULL UNIQUE,
  UNIQUE (version_id, ordinal)
);

CREATE INDEX knowledge_chunks_version_idx
  ON knowledge_chunks (version_id, ordinal);

CREATE TRIGGER knowledge_documents_active_version_guard
BEFORE UPDATE OF active_version_id ON knowledge_documents
WHEN NEW.active_version_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
      FROM knowledge_versions
     WHERE id = NEW.active_version_id
       AND document_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'active knowledge version belongs to another document');
END;

CREATE TRIGGER knowledge_documents_pending_version_guard
BEFORE UPDATE OF pending_version_id ON knowledge_documents
WHEN NEW.pending_version_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
      FROM knowledge_versions
     WHERE id = NEW.pending_version_id
       AND document_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'pending knowledge version belongs to another document');
END;
