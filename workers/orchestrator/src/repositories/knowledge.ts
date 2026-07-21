import { chunkMarkdown } from "../knowledge/chunk";
import { parseMarkdown } from "../knowledge/markdown";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const VECTOR_BATCH_SIZE = 500;
const CHUNK_INSERT_ROWS = 16;
const D1_BATCH_STATEMENTS = 10;
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u;
const FILENAME_PATTERN = /^[^/\\]{1,200}\.md$/iu;

export type KnowledgeDocumentStatus =
  "queued" | "indexing" | "indexed" | "failed" | "deleting" | "delete_failed";
type KnowledgeVersionStatus =
  "queued" | "indexing" | "ready" | "active" | "superseded" | "failed";

export type KnowledgeDatabase = Pick<D1Database, "prepare" | "batch">;

export interface KnowledgeDocument {
  id: string;
  filename: string;
  r2Key: string;
  contentSha256: string;
  status: KnowledgeDocumentStatus;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeChunkRecord {
  id: string;
  documentId: string;
  filename: string;
  headingPath: string[];
  ordinal: number;
  content: string;
  vectorId: string;
}

interface StoredChunk {
  id: string;
  versionId: string;
  headingPath: string[];
  ordinal: number;
  content: string;
  vectorId: string;
}

interface DocumentStateRow {
  id: string;
  filename: string;
  active_version_id: string | null;
  pending_version_id: string | null;
  deletion_status: "deleting" | "delete_failed" | null;
  deletion_error: string | null;
  delete_attempts: number;
  delete_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ListedDocumentRow extends DocumentStateRow {
  version_id: string;
  r2_key: string;
  content_sha256: string;
  version_status: KnowledgeVersionStatus;
  chunk_count: number;
  version_created_at: string;
  version_updated_at: string;
}

interface VersionRow {
  id: string;
  document_id: string;
  filename: string;
  expected_active_version_id: string | null;
  candidate_r2_key: string;
  r2_key: string;
  content_sha256: string;
  status: KnowledgeVersionStatus;
  chunk_count: number;
  created_at: string;
  updated_at: string;
}

interface ChunkRow {
  id: string;
  version_id: string;
  document_id?: string;
  filename?: string;
  heading_path: string;
  ordinal: number;
  content: string;
  vector_id: string;
}

interface VersionSnapshot {
  version: VersionRow;
  chunks: StoredChunk[];
}

export interface KnowledgeBucket {
  put(
    key: string,
    value: ArrayBuffer | ReadableStream,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      sha256?: string;
    },
  ): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream } | null>;
  delete(keys: string | string[]): Promise<void>;
}

export interface KnowledgeVectorIndex {
  upsert(vectors: VectorizeVector[]): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

export interface KnowledgeIndexMessage {
  documentId: string;
  versionId: string;
}

export interface KnowledgeQueue {
  send(message: KnowledgeIndexMessage): Promise<unknown>;
}

interface KnowledgeRepositoryDependencies {
  db: KnowledgeDatabase;
  bucket: KnowledgeBucket;
  index: KnowledgeVectorIndex;
  queue?: KnowledgeQueue;
  embedDocuments: (documents: string[]) => Promise<number[][]>;
  now?: () => Date;
  randomUUID?: () => string;
}

export interface IngestKnowledgeDocument {
  documentId?: string;
  filename: string;
  bytes: Uint8Array;
}

export class KnowledgeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeValidationError";
  }
}

export class KnowledgeNotFoundError extends Error {
  constructor(message = "Knowledge document was not found.") {
    super(message);
    this.name = "KnowledgeNotFoundError";
  }
}

export class KnowledgeConflictError extends Error {
  constructor(message = "Knowledge document changed during replacement.") {
    super(message);
    this.name = "KnowledgeConflictError";
  }
}

export class KnowledgeDeletionError extends Error {
  constructor(message = "Knowledge deletion requires retry.") {
    super(message);
    this.name = "KnowledgeDeletionError";
  }
}

function documentFromRow(row: ListedDocumentRow): KnowledgeDocument {
  return {
    id: row.id,
    filename: row.filename,
    r2Key: row.r2_key,
    contentSha256: row.content_sha256,
    status:
      row.deletion_status ??
      (row.active_version_id === row.version_id
        ? "indexed"
        : row.version_status === "failed"
          ? "failed"
          : row.version_status === "queued"
            ? "queued"
            : "indexing"),
    chunkCount: row.chunk_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function chunkFromRow(row: ChunkRow): StoredChunk {
  const headingPath = JSON.parse(row.heading_path) as unknown;
  if (
    !Array.isArray(headingPath) ||
    !headingPath.every((part) => typeof part === "string")
  ) {
    throw new Error("Stored knowledge heading path is invalid");
  }
  return {
    id: row.id,
    versionId: row.version_id,
    headingPath,
    ordinal: row.ordinal,
    content: row.content,
    vectorId: row.vector_id,
  };
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
  } catch {
    throw new KnowledgeValidationError(
      "Knowledge files must contain UTF-8 text.",
    );
  }
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function metadataValue(
  frontMatter: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = frontMatter[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().slice(0, 200);
    }
  }
  return undefined;
}

function groupsOf<T>(values: readonly T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    groups.push(values.slice(index, index + size));
  }
  return groups;
}

export class KnowledgeRepository {
  readonly #db: KnowledgeDatabase;
  readonly #bucket: KnowledgeBucket;
  readonly #index: KnowledgeVectorIndex;
  readonly #queue: KnowledgeQueue | undefined;
  readonly #embedDocuments: (documents: string[]) => Promise<number[][]>;
  readonly #now: () => Date;
  readonly #randomUUID: () => string;

  constructor(dependencies: KnowledgeRepositoryDependencies) {
    this.#db = dependencies.db;
    this.#bucket = dependencies.bucket;
    this.#index = dependencies.index;
    this.#queue = dependencies.queue;
    this.#embedDocuments = dependencies.embedDocuments;
    this.#now = dependencies.now ?? (() => new Date());
    this.#randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID());
  }

  static validateUpload(filename: string, bytes: Uint8Array): void {
    if (
      !FILENAME_PATTERN.test(filename) ||
      [...filename].some((character) => character.charCodeAt(0) < 32)
    ) {
      throw new KnowledgeValidationError(
        "Knowledge filenames must end in .md and contain no path separators.",
      );
    }
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw new KnowledgeValidationError("Knowledge files cannot exceed 5 MB.");
    }
    const content = decodeUtf8(bytes);
    if (!content.trim()) {
      throw new KnowledgeValidationError("Knowledge files cannot be empty.");
    }
  }

  async listDocuments(): Promise<KnowledgeDocument[]> {
    const result = await this.#db
      .prepare(
        `SELECT d.id, v.filename AS filename, d.active_version_id,
                d.pending_version_id, d.deletion_status, d.deletion_error,
                d.delete_attempts, d.delete_updated_at, d.created_at,
                d.updated_at, v.id AS version_id, v.r2_key,
                v.content_sha256, v.status AS version_status, v.chunk_count,
                v.created_at AS version_created_at,
                v.updated_at AS version_updated_at
           FROM knowledge_documents d
           JOIN knowledge_versions v
             ON v.id = COALESCE(d.pending_version_id, d.active_version_id)
          ORDER BY d.updated_at DESC, d.filename ASC`,
      )
      .all<ListedDocumentRow>();
    return result.results.map(documentFromRow);
  }

  async #documentState(
    documentId: string,
  ): Promise<DocumentStateRow | undefined> {
    const row = await this.#db
      .prepare(
        `SELECT id, filename, active_version_id, pending_version_id,
                deletion_status, deletion_error, delete_attempts,
                delete_updated_at, created_at, updated_at
           FROM knowledge_documents
          WHERE id = ?`,
      )
      .bind(documentId)
      .first<DocumentStateRow>();
    return row ?? undefined;
  }

  async #versionSnapshot(
    versionId: string | null,
  ): Promise<VersionSnapshot | undefined> {
    if (!versionId) return undefined;
    const version = await this.#db
      .prepare(
        `SELECT id, document_id, filename, expected_active_version_id,
                candidate_r2_key, r2_key, content_sha256, status,
                chunk_count, created_at, updated_at
           FROM knowledge_versions
          WHERE id = ?`,
      )
      .bind(versionId)
      .first<VersionRow>();
    if (!version) return undefined;
    const chunks = await this.#db
      .prepare(
        `SELECT id, version_id, heading_path, ordinal, content, vector_id
           FROM knowledge_chunks
          WHERE version_id = ?
          ORDER BY ordinal ASC`,
      )
      .bind(versionId)
      .all<ChunkRow>();
    return {
      version,
      chunks: chunks.results.map(chunkFromRow),
    };
  }

  async #createCandidateMetadata(
    document: DocumentStateRow,
    version: VersionRow,
    isNewDocument: boolean,
  ): Promise<void> {
    const statements: D1PreparedStatement[] = [];
    if (isNewDocument) {
      statements.push(
        this.#db
          .prepare(
            `INSERT INTO knowledge_documents
               (id, filename, active_version_id, pending_version_id,
                deletion_status, deletion_error, delete_attempts,
                delete_updated_at, created_at, updated_at)
             VALUES (?, ?, NULL, NULL, NULL, NULL, 0, NULL, ?, ?)`,
          )
          .bind(
            document.id,
            document.filename,
            document.created_at,
            document.updated_at,
          ),
      );
    }
    statements.push(
      this.#db
        .prepare(
          `INSERT INTO knowledge_versions
             (id, document_id, filename, expected_active_version_id,
              candidate_r2_key, r2_key, content_sha256, status, chunk_count,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          version.id,
          version.document_id,
          version.filename,
          version.expected_active_version_id,
          version.candidate_r2_key,
          version.r2_key,
          version.content_sha256,
          version.status,
          version.chunk_count,
          version.created_at,
          version.updated_at,
        ),
    );
    statements.push(
      this.#db
        .prepare(
          `UPDATE knowledge_documents
              SET pending_version_id = ?, updated_at = ?
            WHERE id = ?
              AND deletion_status IS NULL
              AND (
                (active_version_id IS NULL AND ? IS NULL)
                OR active_version_id = ?
              )
              AND (
                (pending_version_id IS NULL AND ? IS NULL)
                OR pending_version_id = ?
              )`,
        )
        .bind(
          version.id,
          version.updated_at,
          document.id,
          document.active_version_id,
          document.active_version_id,
          document.pending_version_id,
          document.pending_version_id,
        ),
    );
    const results = await this.#db.batch(statements);
    if (results.at(-1)?.meta.changes !== 1) {
      throw new KnowledgeConflictError(
        "Knowledge document changed before staging completed.",
      );
    }
  }

  #chunkInsertStatement(chunks: readonly StoredChunk[]): D1PreparedStatement {
    const placeholders = chunks.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const values = chunks.flatMap((chunk) => [
      chunk.id,
      chunk.versionId,
      JSON.stringify(chunk.headingPath),
      chunk.ordinal,
      chunk.content,
      chunk.vectorId,
    ]);
    return this.#db
      .prepare(
        `INSERT INTO knowledge_chunks
           (id, version_id, heading_path, ordinal, content, vector_id)
         VALUES ${placeholders}`,
      )
      .bind(...values);
  }

  async #insertChunks(chunks: readonly StoredChunk[]): Promise<void> {
    const statements = groupsOf(chunks, CHUNK_INSERT_ROWS).map((group) =>
      this.#chunkInsertStatement(group),
    );
    for (const batch of groupsOf(statements, D1_BATCH_STATEMENTS)) {
      await this.#db.batch(batch);
    }
  }

  async #deleteVectors(ids: readonly string[]): Promise<void> {
    for (const group of groupsOf(ids, VECTOR_BATCH_SIZE)) {
      await this.#index.deleteByIds(group);
    }
  }

  async #upsertVectors(vectors: readonly VectorizeVector[]): Promise<void> {
    for (const group of groupsOf(vectors, VECTOR_BATCH_SIZE)) {
      await this.#index.upsert(group);
    }
  }

  async #deleteInactiveCandidate(
    documentId: string,
    versionId: string,
    vectorIds: readonly string[],
    candidateKey: string,
    finalKey: string,
    isNewDocument: boolean,
  ): Promise<void> {
    await Promise.allSettled([
      this.#db
        .prepare(
          `DELETE FROM knowledge_versions
            WHERE id = ?
              AND NOT EXISTS (
                SELECT 1
                  FROM knowledge_documents
                 WHERE id = ?
                   AND active_version_id = ?
              )`,
        )
        .bind(versionId, documentId, versionId)
        .run(),
      this.#deleteVectors(vectorIds),
      this.#bucket.delete([candidateKey, finalKey]),
    ]);
    if (isNewDocument) {
      await this.#db
        .prepare(
          `DELETE FROM knowledge_documents
            WHERE id = ?
              AND active_version_id IS NULL
              AND NOT EXISTS (
                SELECT 1
                  FROM knowledge_versions
                 WHERE document_id = ?
              )`,
        )
        .bind(documentId, documentId)
        .run();
    }
  }

  async #retirePriorVersion(
    documentId: string,
    prior: VersionSnapshot,
  ): Promise<void> {
    try {
      await this.#deleteVectors(prior.chunks.map((chunk) => chunk.vectorId));
      await this.#bucket.delete(prior.version.r2_key);
      await this.#db
        .prepare(
          `DELETE FROM knowledge_versions
            WHERE id = ?
              AND NOT EXISTS (
                SELECT 1
                  FROM knowledge_documents
                 WHERE id = ?
                   AND active_version_id = ?
              )`,
        )
        .bind(prior.version.id, documentId, prior.version.id)
        .run();
    } catch {
      // Superseded metadata remains available for a later reconciliation pass.
    }
  }

  async ingest(input: IngestKnowledgeDocument): Promise<KnowledgeDocument> {
    KnowledgeRepository.validateUpload(input.filename, input.bytes);
    if (input.documentId && !DOCUMENT_ID_PATTERN.test(input.documentId)) {
      throw new KnowledgeValidationError("Knowledge document id is invalid.");
    }
    if (!this.#queue) {
      throw new Error("Knowledge indexing queue is not configured");
    }

    const now = this.#now().toISOString();
    const existing = input.documentId
      ? await this.#documentState(input.documentId)
      : undefined;
    if (input.documentId && !existing) throw new KnowledgeNotFoundError();
    if (existing?.deletion_status) {
      throw new KnowledgeConflictError("Knowledge document is being deleted.");
    }

    const isNewDocument = !input.documentId;
    const documentId = input.documentId ?? `doc_${this.#randomUUID()}`;
    const expectedActiveVersionId = existing?.active_version_id ?? null;
    const versionId = `ver_${this.#randomUUID()}`;
    const candidateKey = `candidates/${documentId}/${versionId}.md`;
    const finalKey = `documents/${documentId}/${versionId}.md`;
    const contentSha256 = await sha256(input.bytes);
    const document: DocumentStateRow = existing ?? {
      id: documentId,
      filename: input.filename,
      active_version_id: null,
      pending_version_id: null,
      deletion_status: null,
      deletion_error: null,
      delete_attempts: 0,
      delete_updated_at: null,
      created_at: now,
      updated_at: now,
    };
    const version: VersionRow = {
      id: versionId,
      document_id: documentId,
      filename: input.filename,
      expected_active_version_id: expectedActiveVersionId,
      candidate_r2_key: candidateKey,
      r2_key: finalKey,
      content_sha256: contentSha256,
      status: "queued",
      chunk_count: 0,
      created_at: now,
      updated_at: now,
    };

    await this.#bucket.put(candidateKey, ownedArrayBuffer(input.bytes), {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: {
        documentId,
        versionId,
        filename: input.filename,
        contentSha256,
      },
      sha256: contentSha256,
    });

    let metadataRegistered = false;
    try {
      await this.#createCandidateMetadata(document, version, isNewDocument);
      metadataRegistered = true;
      await this.#queue.send({ documentId, versionId });
      return {
        id: documentId,
        filename: input.filename,
        r2Key: finalKey,
        contentSha256,
        status: "queued",
        chunkCount: 0,
        createdAt: document.created_at,
        updatedAt: now,
      };
    } catch (error) {
      if (!metadataRegistered) {
        await this.#deleteInactiveCandidate(
          documentId,
          versionId,
          [],
          candidateKey,
          finalKey,
          isNewDocument,
        );
        if (input.documentId && !(error instanceof KnowledgeConflictError)) {
          throw new KnowledgeConflictError(
            "Knowledge document changed before staging completed.",
          );
        }
        throw error;
      }
      await this.#db
        .prepare(
          "UPDATE knowledge_versions SET status = 'failed', updated_at = ? WHERE id = ?",
        )
        .bind(now, versionId)
        .run();
      throw error;
    }
  }

  async processQueued(
    message: KnowledgeIndexMessage,
  ): Promise<KnowledgeDocument> {
    if (
      !DOCUMENT_ID_PATTERN.test(message.documentId) ||
      !/^ver_[A-Za-z0-9_-]{1,100}$/u.test(message.versionId)
    ) {
      throw new KnowledgeValidationError("Knowledge queue message is invalid.");
    }
    const document = await this.#documentState(message.documentId);
    const snapshot = await this.#versionSnapshot(message.versionId);
    if (
      !document ||
      !snapshot ||
      snapshot.version.document_id !== document.id
    ) {
      throw new KnowledgeNotFoundError();
    }
    if (document.deletion_status) {
      throw new KnowledgeNotFoundError("Knowledge document is being deleted.");
    }
    if (document.active_version_id === snapshot.version.id) {
      return {
        id: document.id,
        filename: document.filename,
        r2Key: snapshot.version.r2_key,
        contentSha256: snapshot.version.content_sha256,
        status: "indexed",
        chunkCount: snapshot.version.chunk_count,
        createdAt: document.created_at,
        updatedAt: document.updated_at,
      };
    }
    if (snapshot.version.status === "superseded") {
      throw new KnowledgeConflictError();
    }

    const now = this.#now().toISOString();
    try {
      if (snapshot.chunks.length > 0) {
        await this.#deleteVectors(
          snapshot.chunks.map((chunk) => chunk.vectorId),
        );
        await this.#db
          .prepare("DELETE FROM knowledge_chunks WHERE version_id = ?")
          .bind(snapshot.version.id)
          .run();
      }
      await this.#db
        .prepare(
          `UPDATE knowledge_versions
              SET status = 'indexing', chunk_count = 0, updated_at = ?
            WHERE id = ?`,
        )
        .bind(now, snapshot.version.id)
        .run();

      const candidate = await this.#bucket.get(
        snapshot.version.candidate_r2_key,
      );
      if (!candidate) throw new Error("Knowledge candidate object was lost");
      const bytes = new Uint8Array(
        await new Response(candidate.body).arrayBuffer(),
      );
      KnowledgeRepository.validateUpload(snapshot.version.filename, bytes);
      const content = decodeUtf8(bytes);
      const parsed = parseMarkdown(content);
      const chunks = chunkMarkdown(snapshot.version.filename, content);
      if (chunks.length === 0) {
        throw new KnowledgeValidationError(
          "Knowledge files must contain Markdown content.",
        );
      }
      const brand = metadataValue(parsed.frontMatter, "brand");
      const workflowCategory = metadataValue(
        parsed.frontMatter,
        "workflow_category",
        "workflowCategory",
      );
      const storedChunks: StoredChunk[] = chunks.map((chunk) => ({
        id: `chunk_${this.#randomUUID()}`,
        versionId: snapshot.version.id,
        headingPath: chunk.headingPath,
        ordinal: chunk.ordinal,
        content: chunk.content,
        vectorId: `vec_${snapshot.version.id
          .slice(4)
          .replaceAll("-", "")}_${chunk.ordinal}`,
      }));
      await this.#insertChunks(storedChunks);
      const embeddings = await this.#embedDocuments(
        storedChunks.map((chunk) => chunk.content),
      );
      if (embeddings.length !== storedChunks.length) {
        throw new Error("Knowledge embedding count does not match chunks");
      }
      await this.#upsertVectors(
        storedChunks.map((chunk, index) => ({
          id: chunk.vectorId,
          values: embeddings[index]!,
          metadata: {
            documentId: document.id,
            versionId: snapshot.version.id,
            chunkId: chunk.id,
            filename: snapshot.version.filename,
            ...(brand ? { brand } : {}),
            ...(workflowCategory ? { workflowCategory } : {}),
          },
        })),
      );
      await this.#bucket.put(snapshot.version.r2_key, ownedArrayBuffer(bytes), {
        httpMetadata: { contentType: "text/markdown; charset=utf-8" },
        customMetadata: {
          documentId: document.id,
          versionId: snapshot.version.id,
          filename: snapshot.version.filename,
          contentSha256: snapshot.version.content_sha256,
        },
        sha256: snapshot.version.content_sha256,
      });
      await this.#db
        .prepare(
          `UPDATE knowledge_versions
              SET status = 'ready', chunk_count = ?, updated_at = ?
            WHERE id = ?`,
        )
        .bind(storedChunks.length, now, snapshot.version.id)
        .run();

      const expectedActiveVersionId =
        snapshot.version.expected_active_version_id;
      const switched = await this.#db
        .prepare(
          `UPDATE knowledge_documents
              SET active_version_id = ?,
                  pending_version_id = CASE
                    WHEN pending_version_id = ? THEN NULL
                    ELSE pending_version_id
                  END,
                  filename = ?,
                  updated_at = ?
            WHERE id = ?
              AND deletion_status IS NULL
              AND (
                (active_version_id IS NULL AND ? IS NULL)
                OR active_version_id = ?
              )
              AND pending_version_id = ?`,
        )
        .bind(
          snapshot.version.id,
          snapshot.version.id,
          snapshot.version.filename,
          now,
          document.id,
          expectedActiveVersionId,
          expectedActiveVersionId,
          snapshot.version.id,
        )
        .run();
      if (switched.meta.changes !== 1) throw new KnowledgeConflictError();

      const prior = await this.#versionSnapshot(expectedActiveVersionId);
      await Promise.allSettled([
        this.#bucket.delete(snapshot.version.candidate_r2_key),
        this.#db.batch([
          this.#db
            .prepare(
              "UPDATE knowledge_versions SET status = 'active', updated_at = ? WHERE id = ?",
            )
            .bind(now, snapshot.version.id),
          ...(expectedActiveVersionId
            ? [
                this.#db
                  .prepare(
                    "UPDATE knowledge_versions SET status = 'superseded', updated_at = ? WHERE id = ?",
                  )
                  .bind(now, expectedActiveVersionId),
              ]
            : []),
        ]),
        ...(prior ? [this.#retirePriorVersion(document.id, prior)] : []),
      ]);

      return {
        id: document.id,
        filename: snapshot.version.filename,
        r2Key: snapshot.version.r2_key,
        contentSha256: snapshot.version.content_sha256,
        status: "indexed",
        chunkCount: storedChunks.length,
        createdAt: document.created_at,
        updatedAt: now,
      };
    } catch (error) {
      await this.#db
        .prepare(
          "UPDATE knowledge_versions SET status = 'failed', updated_at = ? WHERE id = ?",
        )
        .bind(now, snapshot.version.id)
        .run();
      if (error instanceof KnowledgeConflictError) {
        const failedSnapshot = await this.#versionSnapshot(snapshot.version.id);
        await this.#deleteInactiveCandidate(
          document.id,
          snapshot.version.id,
          failedSnapshot?.chunks.map((chunk) => chunk.vectorId) ?? [],
          snapshot.version.candidate_r2_key,
          snapshot.version.r2_key,
          false,
        );
      }
      throw error;
    }
  }

  async deleteDocument(documentId: string): Promise<boolean> {
    if (!DOCUMENT_ID_PATTERN.test(documentId)) {
      throw new KnowledgeValidationError("Knowledge document id is invalid.");
    }
    const document = await this.#documentState(documentId);
    if (!document) return false;
    const deletingAt = this.#now().toISOString();
    await this.#db
      .prepare(
        `UPDATE knowledge_documents
            SET deletion_status = 'deleting',
                deletion_error = NULL,
                delete_attempts = delete_attempts + 1,
                delete_updated_at = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .bind(deletingAt, deletingAt, documentId)
      .run();

    const versions = await this.#db
      .prepare(
        `SELECT id, document_id, filename, expected_active_version_id,
                candidate_r2_key, r2_key, content_sha256, status,
                chunk_count, created_at, updated_at
           FROM knowledge_versions
          WHERE document_id = ?`,
      )
      .bind(documentId)
      .all<VersionRow>();
    const snapshots = (
      await Promise.all(
        versions.results.map((version) => this.#versionSnapshot(version.id)),
      )
    ).filter((snapshot): snapshot is VersionSnapshot => Boolean(snapshot));

    const cleanup = await Promise.allSettled([
      this.#deleteVectors(
        snapshots.flatMap((snapshot) =>
          snapshot.chunks.map((chunk) => chunk.vectorId),
        ),
      ),
      this.#bucket.delete(
        snapshots.flatMap((snapshot) => [
          snapshot.version.r2_key,
          snapshot.version.candidate_r2_key,
        ]),
      ),
    ]);
    if (cleanup.some((result) => result.status === "rejected")) {
      await this.#db
        .prepare(
          `UPDATE knowledge_documents
              SET deletion_status = 'delete_failed',
                  deletion_error = 'external_cleanup_failed',
                  delete_updated_at = ?,
                  updated_at = ?
            WHERE id = ?`,
        )
        .bind(this.#now().toISOString(), this.#now().toISOString(), documentId)
        .run();
      throw new KnowledgeDeletionError();
    }

    await this.#db
      .prepare("DELETE FROM knowledge_documents WHERE id = ?")
      .bind(documentId)
      .run();
    return true;
  }

  async getChunksByVectorIds(
    vectorIds: readonly string[],
  ): Promise<Map<string, KnowledgeChunkRecord>> {
    const unique = [...new Set(vectorIds)].slice(0, 100);
    if (unique.length === 0) return new Map();
    const placeholders = unique.map(() => "?").join(", ");
    const result = await this.#db
      .prepare(
        `SELECT c.id, c.version_id, v.document_id, d.filename,
                c.heading_path, c.ordinal, c.content, c.vector_id
           FROM knowledge_chunks c
           JOIN knowledge_versions v ON v.id = c.version_id
           JOIN knowledge_documents d
             ON d.id = v.document_id
            AND d.active_version_id = v.id
            AND d.deletion_status IS NULL
          WHERE c.vector_id IN (${placeholders})`,
      )
      .bind(...unique)
      .all<ChunkRow>();
    return new Map(
      result.results.map((row) => {
        const chunk = chunkFromRow(row);
        return [
          chunk.vectorId,
          {
            id: chunk.id,
            documentId: row.document_id ?? "",
            filename: row.filename ?? "knowledge.md",
            headingPath: chunk.headingPath,
            ordinal: chunk.ordinal,
            content: chunk.content,
            vectorId: chunk.vectorId,
          },
        ];
      }),
    );
  }
}
