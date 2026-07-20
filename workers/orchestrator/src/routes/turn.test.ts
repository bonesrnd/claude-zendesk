import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ticket = {
  ticketId: 8421,
  subject: "Where is my order?",
  requester: { id: 77, name: "Maya Chen", email: "maya@example.com" },
  recentConversation: [],
};

function anthropicMessage(content: unknown[], stopReason: string) {
  return {
    id: "msg_model",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

function workerRequest(path: string, body: unknown, headers?: HeadersInit) {
  return exports.default.fetch(
    new Request(`https://worker.test${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.BACKEND_AUTH_TOKEN}`,
        "content-type": "application/json",
        "x-resolve-tenant": env.TENANT_KEY,
        "x-resolve-anthropic-key": "anthropic-test",
        "x-resolve-anthropic-model": "claude-test",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pending_turns"),
    env.DB.prepare("DELETE FROM tool_runs"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM conversations"),
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /v1/turn", () => {
  it("creates a conversation and persists both display messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          Response.json(
            anthropicMessage(
              [{ type: "text", text: "The order shipped." }],
              "end_turn",
            ),
          ),
        ),
    );

    const response = await workerRequest("/v1/turn", {
      message: "Check the latest order",
      ticket,
      agent: { id: 9, name: "Agent" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-resolve-request-id")).toMatch(/^req_/);
    const body = await response.json();
    expect(body).toMatchObject({
      kind: "assistant_message",
      content: "The order shipped.",
    });
    const rows = await env.DB.prepare(
      "SELECT role, content FROM messages ORDER BY created_at, id",
    ).all();
    expect(rows.results).toEqual([
      { role: "user", content: "Check the latest order" },
      { role: "assistant", content: "The order shipped." },
    ]);
  });

  it("rejects a different tenant", async () => {
    const response = await workerRequest(
      "/v1/turn",
      {
        message: "Check the latest order",
        ticket,
        agent: { id: 9, name: "Agent" },
      },
      { "x-resolve-tenant": "other-tenant" },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      kind: "error",
      code: "unauthorized",
    });
  });

  it("rejects credentials in the JSON body", async () => {
    const response = await workerRequest("/v1/turn", {
      message: "Check the latest order",
      ticket,
      agent: { id: 9, name: "Agent" },
      anthropicApiKey: "must-not-be-accepted",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      kind: "error",
      code: "validation_error",
    });
  });

  it("pauses and resumes delegated Zendesk tools", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        Response.json(
          anthropicMessage(
            [
              {
                type: "tool_use",
                id: "tool_zd_1",
                name: "zendesk_get_requester_tickets",
                input: { requesterId: 77, limit: 10 },
              },
            ],
            "tool_use",
          ),
        ),
      )
      .mockImplementationOnce(async () =>
        Response.json(
          anthropicMessage(
            [{ type: "text", text: "Ticket 7314 used a replacement." }],
            "end_turn",
          ),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const first = await workerRequest("/v1/turn", {
      message: "How was this handled before?",
      ticket,
      agent: { id: 9, name: "Agent" },
    });
    const delegated = await first.json<{
      kind: string;
      turnId: string;
      requests: unknown[];
    }>();
    expect(delegated).toMatchObject({
      kind: "delegated_tool_request",
      requests: [{ toolUseId: "tool_zd_1" }],
    });

    const continued = await workerRequest("/v1/turn/continue", {
      turnId: delegated.turnId,
      results: [
        {
          toolUseId: "tool_zd_1",
          toolName: "zendesk_get_requester_tickets",
          output: {
            tickets: [
              {
                ticketId: 7314,
                subject: "Damaged item",
                status: "solved",
                createdAt: "2026-01-01T12:00:00.000Z",
                updatedAt: "2026-01-02T12:00:00.000Z",
                snippet: "Replacement sent",
                url: "https://example.zendesk.com/agent/tickets/7314",
              },
            ],
            citations: [
              {
                provider: "zendesk",
                label: "Ticket 7314",
                providerId: "7314",
                url: "https://example.zendesk.com/agent/tickets/7314",
              },
            ],
          },
          isError: false,
        },
      ],
    });

    expect(continued.status).toBe(200);
    await expect(continued.json()).resolves.toMatchObject({
      kind: "assistant_message",
      content: "Ticket 7314 used a replacement.",
      citations: [{ providerId: "7314" }],
    });
    const pending = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM pending_turns",
    ).first<{ count: number }>();
    expect(pending?.count).toBe(0);
  });

  it("returns persisted conversation identifiers with partial errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          Response.json(
            anthropicMessage(
              [{ type: "text", text: "A partial answer" }],
              "max_tokens",
            ),
          ),
        ),
    );

    const response = await workerRequest("/v1/turn", {
      message: "Check the order",
      ticket,
      agent: { id: 9, name: "Agent" },
    });
    const body = await response.json<{
      kind: string;
      partial?: { conversationId: string; messageId: string };
    }>();

    expect(response.status).toBe(429);
    expect(body).toMatchObject({
      kind: "error",
      partial: {
        conversationId: expect.stringMatching(/^conv_/),
        messageId: expect.stringMatching(/^msg_/),
      },
    });
  });
});
