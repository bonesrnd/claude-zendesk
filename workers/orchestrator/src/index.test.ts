import { env, exports } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  createScheduledController,
  reset,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "./index";
import {
  KnowledgeRepository,
  type KnowledgeBucket,
  type KnowledgeIndexMessage,
  type KnowledgeVectorIndex,
} from "./repositories/knowledge";

class QueueTestBucket implements KnowledgeBucket {
  readonly objects = new Map<string, ArrayBuffer>();

  async put(
    key: string,
    value: ArrayBuffer | ReadableStream,
  ): Promise<unknown> {
    const bytes =
      value instanceof ArrayBuffer
        ? value.slice(0)
        : await new Response(value).arrayBuffer();
    this.objects.set(key, bytes);
    return { key };
  }

  get(key: string): Promise<{ body: ReadableStream } | null> {
    const value = this.objects.get(key);
    return Promise.resolve(value ? { body: new Blob([value]).stream() } : null);
  }

  delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.objects.delete(key);
    }
    return Promise.resolve();
  }
}

class QueueTestVectorIndex implements KnowledgeVectorIndex {
  readonly vectors = new Map<string, VectorizeVector>();

  upsert(vectors: VectorizeVector[]): Promise<unknown> {
    for (const vector of vectors) this.vectors.set(vector.id, vector);
    return Promise.resolve({ mutationId: "upsert" });
  }

  deleteByIds(ids: string[]): Promise<unknown> {
    for (const id of ids) this.vectors.delete(id);
    return Promise.resolve({ mutationId: "delete" });
  }
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function request(path = "/health", token?: string) {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  return exports.default.fetch(
    new Request(`https://worker.test${path}`, { headers }),
  );
}

describe("Worker authentication", () => {
  it("exports a knowledge queue consumer", () => {
    expect(typeof worker.queue === "function").toBe(true);
  });

  it("processes a staged document through the default queue entrypoint", async () => {
    const bucket = new QueueTestBucket();
    const index = new QueueTestVectorIndex();
    const queuedMessages: KnowledgeIndexMessage[] = [];
    const repository = new KnowledgeRepository({
      db: env.DB,
      bucket,
      index,
      queue: {
        send(message) {
          queuedMessages.push(structuredClone(message));
          return Promise.resolve();
        },
      },
      embedDocuments: async () => {
        throw new Error("Staging must not embed documents");
      },
    });
    const staged = await repository.ingest({
      filename: "returns.md",
      bytes: new TextEncoder().encode(
        "---\nbrand: Solution Peptides\nworkflow_category: returns\n---\n# Returns\n\nConfirm identity before approval.",
      ),
    });
    const queued = queuedMessages[0];
    if (!queued) throw new Error("Expected a staged queue message");
    const ack = vi.fn();
    const retry = vi.fn();
    const aiRun = vi.fn(
      async (
        _model: string,
        input: { documents?: string[]; queries?: string[] },
      ) => ({
        data: (input.documents ?? input.queries ?? []).map(() =>
          Array.from({ length: 1_024 }, () => 0.25),
        ),
      }),
    );
    const fakeEnv = {
      DB: env.DB,
      KNOWLEDGE_BUCKET: bucket,
      KNOWLEDGE_INDEX: index,
      AI: { run: aiRun },
    } as unknown as Env;

    await worker.queue(
      {
        messages: [
          {
            body: queued,
            attempts: 1,
            ack,
            retry,
          },
        ],
      } as unknown as MessageBatch,
      fakeEnv,
    );

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(aiRun).toHaveBeenCalledWith(
      "@cf/qwen/qwen3-embedding-0.6b",
      expect.objectContaining({ documents: expect.any(Array) }),
    );
    expect(index.vectors.size).toBeGreaterThan(0);
    await expect(repository.listDocuments()).resolves.toEqual([
      expect.objectContaining({
        id: staged.id,
        filename: "returns.md",
        status: "indexed",
        chunkCount: 1,
      }),
    ]);
    const state = await env.DB.prepare(
      `SELECT d.active_version_id, d.pending_version_id, v.status
         FROM knowledge_documents d
         JOIN knowledge_versions v ON v.id = d.active_version_id
        WHERE d.id = ?`,
    )
      .bind(staged.id)
      .first<{
        active_version_id: string;
        pending_version_id: string | null;
        status: string;
      }>();
    expect(state).toMatchObject({
      active_version_id: queued.versionId,
      pending_version_id: null,
      status: "active",
    });
  });

  it("rejects a missing backend token", async () => {
    const response = await request();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      kind: "error",
      code: "unauthorized",
    });
  });

  it("serves health to an authenticated installation", async () => {
    const response = await request("/health", env.BACKEND_AUTH_TOKEN);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "resolve-orchestrator",
    });
  });

  it("does not authorize admin routes with the Zendesk backend token", async () => {
    const response = await request("/admin/knowledge", env.BACKEND_AUTH_TOKEN);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      kind: "error",
      code: "unauthorized",
    });
  });

  it("returns a stable not-found response", async () => {
    const response = await request("/missing", env.BACKEND_AUTH_TOKEN);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      kind: "error",
      code: "validation_error",
    });
  });

  it("enforces the installation request budget", async () => {
    for (let count = 0; count < 60; count += 1) {
      const response = await request("/health", env.BACKEND_AUTH_TOKEN);
      expect(response.status).toBe(200);
    }

    const response = await request("/health", env.BACKEND_AUTH_TOKEN);
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      kind: "error",
      code: "rate_limited",
      retryable: true,
    });
  });

  it("logs safe request completion metadata", async () => {
    const write = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await request("/health", env.BACKEND_AUTH_TOKEN);

    const entry = JSON.parse(String(write.mock.calls.at(-1)?.[0]));
    expect(entry).toMatchObject({
      level: "info",
      event: "request.completed",
      httpStatus: 200,
    });
    expect(JSON.stringify(entry)).not.toContain(env.BACKEND_AUTH_TOKEN);
  });

  it("removes expired conversations, pending turns, and write proposals on schedule", async () => {
    await env.DB.prepare(
      `INSERT INTO conversations
        (id, tenant_key, ticket_id, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "conv_expired",
        env.TENANT_KEY,
        8421,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO write_proposals
        (id, conversation_id, agent_id, action, target_id, before_json,
         changes_json, record_version, capability_hash, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "proposal_expired",
        "conv_expired",
        9,
        "zendesk_update_customer_profile",
        77,
        "{}",
        '{"notes":"Updated"}',
        "version-1",
        "f".repeat(64),
        "2026-01-02T00:00:00.000Z",
        "pending",
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO pending_turns
        (id, conversation_id, state_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        "turn_expired",
        "conv_expired",
        "{}",
        "2026-01-01T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
      )
      .run();
    const context = createExecutionContext();

    worker.scheduled(
      createScheduledController({
        scheduledTime: new Date("2026-07-18T00:00:00.000Z").getTime(),
        cron: "0 3 * * *",
      }),
      env,
      context,
    );
    await waitOnExecutionContext(context);

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM conversations",
    ).first<{ count: number }>();
    expect(count?.count).toBe(0);
    const proposalCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM write_proposals",
    ).first<{ count: number }>();
    expect(proposalCount?.count).toBe(0);
  });
});
