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

  it("removes expired conversation and pending-turn rows on schedule", async () => {
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
  });
});
