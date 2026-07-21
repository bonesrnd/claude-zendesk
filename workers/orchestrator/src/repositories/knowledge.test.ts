import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  KnowledgeConflictError,
  KnowledgeDeletionError,
  KnowledgeNotFoundError,
  KnowledgeRepository,
  KnowledgeValidationError,
  type KnowledgeBucket,
  type KnowledgeDatabase,
  type KnowledgeDocument,
  type KnowledgeIndexMessage,
  type KnowledgeQueue,
  type KnowledgeVectorIndex,
} from "./knowledge";

interface BucketPutOptions {
  customMetadata?: Record<string, string>;
}

class FakeBucket implements KnowledgeBucket {
  readonly objects = new Map<string, ArrayBuffer>();
  readonly uploadSizes: number[] = [];
  failPromotion = false;
  failDeleteCount = 0;
  discardBodies = false;
  onCandidatePut?: (
    key: string,
    options: BucketPutOptions | undefined,
  ) => Promise<void>;
  onPromotion?: (
    key: string,
    options: BucketPutOptions | undefined,
  ) => Promise<void>;

  async put(
    key: string,
    value: ArrayBuffer | ReadableStream,
    options?: BucketPutOptions,
  ): Promise<unknown> {
    if (this.failPromotion && key.startsWith("documents/")) {
      throw new Error("synthetic promotion failure");
    }
    if (key.startsWith("documents/")) {
      await this.onPromotion?.(key, options);
    }
    const bytes =
      value instanceof ArrayBuffer
        ? value.slice(0)
        : await new Response(value).arrayBuffer();
    this.uploadSizes.push(bytes.byteLength);
    this.objects.set(key, this.discardBodies ? new ArrayBuffer(0) : bytes);
    if (key.startsWith("candidates/")) {
      await this.onCandidatePut?.(key, options);
    }
    return { key };
  }

  get(key: string): Promise<{ body: ReadableStream } | null> {
    const value = this.objects.get(key);
    return Promise.resolve(value ? { body: new Blob([value]).stream() } : null);
  }

  delete(keys: string | string[]): Promise<void> {
    if (this.failDeleteCount > 0) {
      this.failDeleteCount -= 1;
      return Promise.reject(new Error("synthetic R2 deletion failure"));
    }
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.objects.delete(key);
    }
    return Promise.resolve();
  }

  async text(key: string): Promise<string | undefined> {
    const value = this.objects.get(key);
    return value ? new TextDecoder().decode(value) : undefined;
  }
}

class FakeVectorIndex implements KnowledgeVectorIndex {
  readonly vectors = new Map<string, VectorizeVector>();
  failUpsert = false;
  failDeleteCount = 0;

  upsert(vectors: VectorizeVector[]): Promise<unknown> {
    if (this.failUpsert) throw new Error("synthetic vector failure");
    for (const vector of vectors) this.vectors.set(vector.id, vector);
    return Promise.resolve({ mutationId: "upsert" });
  }

  deleteByIds(ids: string[]): Promise<unknown> {
    if (this.failDeleteCount > 0) {
      this.failDeleteCount -= 1;
      return Promise.reject(new Error("synthetic vector deletion failure"));
    }
    for (const id of ids) this.vectors.delete(id);
    return Promise.resolve({ mutationId: "delete" });
  }
}

class FakeQueue implements KnowledgeQueue {
  readonly messages: KnowledgeIndexMessage[] = [];

  send(message: KnowledgeIndexMessage): Promise<void> {
    this.messages.push(structuredClone(message));
    return Promise.resolve();
  }
}

interface DatabaseMetrics {
  maxBatchStatements: number;
  maxBoundParameters: number;
  chunkInsertStatements: number;
}

function trackedDatabase(database: D1Database): {
  db: KnowledgeDatabase;
  metrics: DatabaseMetrics;
} {
  const metrics: DatabaseMetrics = {
    maxBatchStatements: 0,
    maxBoundParameters: 0,
    chunkInsertStatements: 0,
  };
  return {
    metrics,
    db: {
      prepare(query) {
        if (/INSERT INTO knowledge_chunks/iu.test(query)) {
          metrics.chunkInsertStatements += 1;
        }
        const statement = database.prepare(query);
        return new Proxy(statement, {
          get(target, property) {
            if (property === "bind") {
              return (...values: unknown[]) => {
                metrics.maxBoundParameters = Math.max(
                  metrics.maxBoundParameters,
                  values.length,
                );
                return target.bind(...values);
              };
            }
            const value = Reflect.get(target, property);
            // Native D1 statements require their receiver; this proxy only
            // observes bind counts and otherwise preserves the platform API.
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
      batch(statements) {
        metrics.maxBatchStatements = Math.max(
          metrics.maxBatchStatements,
          statements.length,
        );
        return database.batch(statements);
      },
    },
  };
}

function dependencies(db: KnowledgeDatabase = env.DB) {
  let sequence = 0;
  const bucket = new FakeBucket();
  const index = new FakeVectorIndex();
  const queue = new FakeQueue();
  const repository = new KnowledgeRepository({
    db,
    bucket,
    index,
    queue,
    embedDocuments: async (documents) =>
      documents.map((_, index) => [index + 0.1, index + 0.2]),
    now: () => new Date("2026-07-21T12:00:00.000Z"),
    randomUUID: () =>
      `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  });
  return { bucket, index, queue, repository };
}

async function processNext(
  repository: KnowledgeRepository,
  queue: FakeQueue,
): Promise<KnowledgeDocument> {
  const message = queue.messages.shift();
  if (!message) throw new Error("Expected a queued knowledge message");
  return repository.processQueued(message);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("KnowledgeRepository", () => {
  it("validates Markdown filename, UTF-8, file size, and upload count", () => {
    expect(() =>
      KnowledgeRepository.validateUpload("workflow.txt", new Uint8Array()),
    ).toThrow(KnowledgeValidationError);
    expect(() =>
      KnowledgeRepository.validateUpload(
        "workflow.md",
        new Uint8Array([0xc3, 0x28]),
      ),
    ).toThrow("UTF-8");
    expect(() =>
      KnowledgeRepository.validateUpload(
        "workflow.md",
        new Uint8Array(5 * 1024 * 1024 + 1),
      ),
    ).toThrow("5 MB");
    expect(() =>
      KnowledgeRepository.validateUpload(
        "workflow.md",
        new TextEncoder().encode("   \n"),
      ),
    ).toThrow("empty");
  });

  it("keeps the candidate inactive until R2 promotion completes", async () => {
    const { bucket, index, queue, repository } = dependencies();
    let activeVersionDuringPromotion: string | null | undefined;
    bucket.onPromotion = async () => {
      const row = await env.DB.prepare(
        "SELECT active_version_id FROM knowledge_documents LIMIT 1",
      ).first<{ active_version_id: string | null }>();
      activeVersionDuringPromotion = row?.active_version_id;
    };

    const queued = await repository.ingest({
      filename: "shipping.md",
      bytes: new TextEncoder().encode(
        "---\nbrand: Atomik Labz\nworkflow_category: shipping\n---\n# Shipping\n\nConfirm tracking.",
      ),
    });

    expect(queued.status).toBe("queued");
    expect(queued.chunkCount).toBe(0);
    expect(index.vectors.size).toBe(0);
    expect(queue.messages).toHaveLength(1);
    expect(queue.messages[0]).toEqual({
      documentId: queued.id,
      versionId: expect.stringMatching(/^ver_/u),
    });

    const document = await processNext(repository, queue);

    expect(activeVersionDuringPromotion).toBeNull();
    expect(document).toMatchObject({
      filename: "shipping.md",
      status: "indexed",
      chunkCount: 1,
    });
    expect(await bucket.text(document.r2Key)).toContain("Confirm tracking.");
    expect(index.vectors.size).toBe(1);
    await expect(repository.listDocuments()).resolves.toEqual([document]);
  });

  it("keeps the prior active version queryable when replacement indexing fails", async () => {
    const { bucket, index, queue, repository } = dependencies();
    await repository.ingest({
      filename: "returns.md",
      bytes: new TextEncoder().encode(
        "# Returns\n\nUse the original approved workflow.",
      ),
    });
    const original = await processNext(repository, queue);
    const originalObject = await bucket.text(original.r2Key);
    const originalVectorIds = [...index.vectors.keys()];
    index.failUpsert = true;

    await repository.ingest({
      documentId: original.id,
      filename: "returns-updated.md",
      bytes: new TextEncoder().encode(
        "# Returns\n\nThis replacement must not activate.",
      ),
    });
    await expect(repository.listDocuments()).resolves.toEqual([
      expect.objectContaining({
        id: original.id,
        filename: "returns-updated.md",
        status: "queued",
      }),
    ]);
    await expect(processNext(repository, queue)).rejects.toThrow(
      "synthetic vector failure",
    );

    await expect(repository.listDocuments()).resolves.toEqual([
      expect.objectContaining({
        id: original.id,
        filename: "returns-updated.md",
        status: "failed",
      }),
    ]);
    const searchable = await repository.getChunksByVectorIds(originalVectorIds);
    expect([...searchable.keys()]).toEqual(originalVectorIds);
    expect(await bucket.text(original.r2Key)).toBe(originalObject);
    expect([...index.vectors.keys()]).toEqual(originalVectorIds);
  });

  it("keeps the prior active pointer when candidate promotion fails", async () => {
    const { bucket, index, queue, repository } = dependencies();
    await repository.ingest({
      filename: "returns.md",
      bytes: new TextEncoder().encode("# Returns\n\nOriginal."),
    });
    const original = await processNext(repository, queue);
    const originalVectorIds = [...index.vectors.keys()];
    bucket.failPromotion = true;

    await repository.ingest({
      documentId: original.id,
      filename: "renamed.md",
      bytes: new TextEncoder().encode("# Returns\n\nReplacement."),
    });
    await expect(processNext(repository, queue)).rejects.toThrow(
      "synthetic promotion failure",
    );

    await expect(repository.listDocuments()).resolves.toEqual([
      expect.objectContaining({
        id: original.id,
        filename: "renamed.md",
        status: "failed",
      }),
    ]);
    const searchable = await repository.getChunksByVectorIds([
      ...index.vectors.keys(),
    ]);
    expect([...searchable.keys()]).toEqual(originalVectorIds);
    expect(await bucket.text(original.r2Key)).toContain("Original.");
  });

  it("rejects an unknown replacement id without creating a caller-chosen document", async () => {
    const { bucket, index, repository } = dependencies();

    await expect(
      repository.ingest({
        documentId: "doc_missing",
        filename: "returns.md",
        bytes: new TextEncoder().encode("# Returns\n\nReplacement."),
      }),
    ).rejects.toBeInstanceOf(KnowledgeNotFoundError);

    await expect(repository.listDocuments()).resolves.toEqual([]);
    expect(bucket.objects.size).toBe(0);
    expect(index.vectors.size).toBe(0);
  });

  it("never activates an older queued candidate after pending advances", async () => {
    const { bucket, index, queue, repository } = dependencies();
    const firstStage = await repository.ingest({
      filename: "first.md",
      bytes: new TextEncoder().encode("# Returns\n\nFirst candidate."),
    });
    const firstMessage = queue.messages.shift();
    if (!firstMessage) throw new Error("Expected first queued candidate");
    await repository.ingest({
      documentId: firstStage.id,
      filename: "second.md",
      bytes: new TextEncoder().encode("# Returns\n\nSecond candidate wins."),
    });
    const secondMessage = queue.messages.shift();
    if (!secondMessage) throw new Error("Expected second queued candidate");

    await expect(repository.processQueued(firstMessage)).rejects.toBeInstanceOf(
      KnowledgeConflictError,
    );

    expect(
      [...index.vectors.values()].some(
        (vector) => vector.metadata?.filename === "first.md",
      ),
    ).toBe(false);
    expect(
      [...bucket.objects.keys()].some((key) =>
        key.includes(firstMessage.versionId),
      ),
    ).toBe(false);
    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM knowledge_versions WHERE id = ?",
      )
        .bind(firstMessage.versionId)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 0 });

    const winner = await repository.processQueued(secondMessage);

    expect(winner).toMatchObject({
      id: firstStage.id,
      filename: "second.md",
      status: "indexed",
    });
    await expect(repository.listDocuments()).resolves.toEqual([winner]);
    expect(await bucket.text(winner.r2Key)).toContain("Second candidate wins.");
  });

  it("uses active-version CAS so a stale concurrent replacement cannot roll back the winner", async () => {
    const { bucket, index, queue, repository } = dependencies();
    await repository.ingest({
      filename: "returns.md",
      bytes: new TextEncoder().encode("# Returns\n\nOriginal."),
    });
    const original = await processNext(repository, queue);
    const firstReachedPromotion = deferred();
    const secondReachedPromotion = deferred();
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    bucket.onPromotion = async (_key, options) => {
      const filename = options?.customMetadata?.filename;
      if (filename === "first.md") {
        firstReachedPromotion.resolve();
        await releaseFirst.promise;
      }
      if (filename === "second.md") {
        secondReachedPromotion.resolve();
        await releaseSecond.promise;
      }
    };

    await repository.ingest({
      documentId: original.id,
      filename: "first.md",
      bytes: new TextEncoder().encode("# Returns\n\nFirst replacement."),
    });
    const firstMessage = queue.messages.shift();
    if (!firstMessage) throw new Error("Expected first replacement message");
    const first = repository.processQueued(firstMessage);
    await firstReachedPromotion.promise;
    await repository.ingest({
      documentId: original.id,
      filename: "second.md",
      bytes: new TextEncoder().encode("# Returns\n\nSecond replacement wins."),
    });
    const secondMessage = queue.messages.shift();
    if (!secondMessage) throw new Error("Expected second replacement message");
    const second = repository.processQueued(secondMessage);
    await secondReachedPromotion.promise;
    releaseSecond.resolve();
    const winner = await second;
    releaseFirst.resolve();

    await expect(first).rejects.toBeInstanceOf(KnowledgeConflictError);
    await expect(repository.listDocuments()).resolves.toEqual([winner]);
    expect(winner.filename).toBe("second.md");
    expect(await bucket.text(winner.r2Key)).toContain(
      "Second replacement wins.",
    );
    expect(
      [...index.vectors.values()].some(
        (vector) => vector.metadata?.filename === "first.md",
      ),
    ).toBe(false);
  });

  it("rejects and removes a staged candidate when deletion tombstones first", async () => {
    const { bucket, queue, repository } = dependencies();
    await repository.ingest({
      filename: "returns.md",
      bytes: new TextEncoder().encode("# Returns\n\nOriginal."),
    });
    const original = await processNext(repository, queue);
    const candidateStored = deferred();
    const releaseCandidate = deferred();
    bucket.onCandidatePut = async (_key, options) => {
      if (options?.customMetadata?.filename !== "race.md") return;
      candidateStored.resolve();
      await releaseCandidate.promise;
    };

    const upload = repository.ingest({
      documentId: original.id,
      filename: "race.md",
      bytes: new TextEncoder().encode("# Returns\n\nRacing replacement."),
    });
    await candidateStored.promise;
    await repository.deleteDocument(original.id);
    releaseCandidate.resolve();

    await expect(upload).rejects.toBeInstanceOf(KnowledgeConflictError);
    expect(queue.messages).toHaveLength(0);
    expect(bucket.objects.size).toBe(0);
    await expect(repository.listDocuments()).resolves.toEqual([]);
  });

  it("uses checked pending-version CAS so only one concurrent stage queues", async () => {
    const { bucket, queue, repository } = dependencies();
    await repository.ingest({
      filename: "returns.md",
      bytes: new TextEncoder().encode("# Returns\n\nOriginal."),
    });
    const original = await processNext(repository, queue);
    const firstStored = deferred();
    const secondStored = deferred();
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    bucket.onCandidatePut = async (_key, options) => {
      if (options?.customMetadata?.filename === "first-stage.md") {
        firstStored.resolve();
        await releaseFirst.promise;
      }
      if (options?.customMetadata?.filename === "second-stage.md") {
        secondStored.resolve();
        await releaseSecond.promise;
      }
    };

    const first = repository.ingest({
      documentId: original.id,
      filename: "first-stage.md",
      bytes: new TextEncoder().encode("# Returns\n\nFirst."),
    });
    const second = repository.ingest({
      documentId: original.id,
      filename: "second-stage.md",
      bytes: new TextEncoder().encode("# Returns\n\nSecond."),
    });
    await Promise.all([firstStored.promise, secondStored.promise]);
    releaseFirst.resolve();
    await expect(first).resolves.toMatchObject({ status: "queued" });
    releaseSecond.resolve();

    await expect(second).rejects.toBeInstanceOf(KnowledgeConflictError);
    expect(queue.messages).toHaveLength(1);
    expect(
      [...bucket.objects.keys()].filter((key) => key.startsWith("candidates/")),
    ).toHaveLength(1);
  });

  it("indexes an exact 5 MiB Markdown file within D1 bind and batch limits", async () => {
    const tracked = trackedDatabase(env.DB);
    const { queue, repository } = dependencies(tracked.db);
    const prefix = "# Scale\n\n";
    const content = `${prefix}${"x".repeat(5 * 1024 * 1024 - prefix.length)}`;
    const bytes = new TextEncoder().encode(content);
    expect(bytes.byteLength).toBe(5 * 1024 * 1024);

    const queued = await repository.ingest({
      filename: "scale.md",
      bytes,
    });

    expect(queued.status).toBe("queued");
    expect(tracked.metrics.chunkInsertStatements).toBe(0);
    const document = await processNext(repository, queue);

    expect(document.status).toBe("indexed");
    expect(document.chunkCount).toBeGreaterThan(1_000);
    expect(tracked.metrics.maxBoundParameters).toBeLessThanOrEqual(100);
    expect(tracked.metrics.maxBatchStatements).toBeLessThanOrEqual(20);
    expect(tracked.metrics.chunkInsertStatements).toBeLessThan(
      document.chunkCount,
    );
  }, 30_000);

  it("stages fifty 5 MiB files as bounded queue messages without indexing", async () => {
    const tracked = trackedDatabase(env.DB);
    const { bucket, index, queue, repository } = dependencies(tracked.db);
    bucket.discardBodies = true;
    const prefix = "# Aggregate\n\n";
    const bytes = new TextEncoder().encode(
      `${prefix}${"x".repeat(5 * 1024 * 1024 - prefix.length)}`,
    );

    for (let index = 0; index < 50; index += 1) {
      const document = await repository.ingest({
        filename: `file-${index}.md`,
        bytes,
      });
      expect(document.status).toBe("queued");
    }

    expect(queue.messages).toHaveLength(50);
    expect(
      queue.messages.every(
        (message) =>
          Object.keys(message).sort().join(",") === "documentId,versionId" &&
          JSON.stringify(message).length < 200,
      ),
    ).toBe(true);
    expect(bucket.uploadSizes).toEqual(
      Array.from({ length: 50 }, () => 5 * 1024 * 1024),
    );
    expect(index.vectors.size).toBe(0);
    expect(tracked.metrics.chunkInsertStatements).toBe(0);
    expect(tracked.metrics.maxBoundParameters).toBeLessThanOrEqual(100);
    expect(tracked.metrics.maxBatchStatements).toBeLessThanOrEqual(3);
  }, 30_000);

  it("deletes the active document, versions, object, chunks, and vectors", async () => {
    const { bucket, index, queue, repository } = dependencies();
    await repository.ingest({
      filename: "policy.md",
      bytes: new TextEncoder().encode("# Policy\n\nOne policy."),
    });
    const document = await processNext(repository, queue);

    const deleted = await repository.deleteDocument(document.id);

    expect(deleted).toBe(true);
    expect(bucket.objects.size).toBe(0);
    expect(index.vectors.size).toBe(0);
    await expect(repository.listDocuments()).resolves.toEqual([]);
    const versionCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM knowledge_versions",
    ).first<{ count: number }>();
    const chunkCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM knowledge_chunks",
    ).first<{ count: number }>();
    expect(versionCount?.count).toBe(0);
    expect(chunkCount?.count).toBe(0);
  });

  it("retains a delete_failed tombstone after R2 failure and succeeds on retry", async () => {
    const { bucket, index, queue, repository } = dependencies();
    await repository.ingest({
      filename: "policy.md",
      bytes: new TextEncoder().encode("# Policy\n\nOne policy."),
    });
    const document = await processNext(repository, queue);
    bucket.failDeleteCount = 1;

    await expect(repository.deleteDocument(document.id)).rejects.toBeInstanceOf(
      KnowledgeDeletionError,
    );

    await expect(repository.listDocuments()).resolves.toEqual([
      expect.objectContaining({
        id: document.id,
        status: "delete_failed",
      }),
    ]);
    expect(index.vectors.size).toBe(0);
    const retained = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM knowledge_versions WHERE document_id = ?",
    )
      .bind(document.id)
      .first<{ count: number }>();
    expect(retained?.count).toBeGreaterThan(0);

    await expect(repository.deleteDocument(document.id)).resolves.toBe(true);
    await expect(repository.listDocuments()).resolves.toEqual([]);
  });

  it("retains a delete_failed tombstone after Vectorize failure and succeeds on retry", async () => {
    const { bucket, index, queue, repository } = dependencies();
    await repository.ingest({
      filename: "policy.md",
      bytes: new TextEncoder().encode("# Policy\n\nOne policy."),
    });
    const document = await processNext(repository, queue);
    index.failDeleteCount = 1;

    await expect(repository.deleteDocument(document.id)).rejects.toBeInstanceOf(
      KnowledgeDeletionError,
    );

    await expect(repository.listDocuments()).resolves.toEqual([
      expect.objectContaining({
        id: document.id,
        status: "delete_failed",
      }),
    ]);
    expect(bucket.objects.size).toBe(0);
    const retained = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM knowledge_versions WHERE document_id = ?",
    )
      .bind(document.id)
      .first<{ count: number }>();
    expect(retained?.count).toBeGreaterThan(0);

    await expect(repository.deleteDocument(document.id)).resolves.toBe(true);
    await expect(repository.listDocuments()).resolves.toEqual([]);
  });
});
