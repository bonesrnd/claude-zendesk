import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../index";

const ticket = {
  ticketId: 8421,
  subject: "Where is my order?",
  requester: { id: 77, name: "Maya Chen", email: "maya@example.com" },
  brand: { id: 123, name: "Solution Peptides" },
  recentConversation: [],
};

const shipstationShipment = {
  shipment_id: "se-28529731",
  shipment_number: "10982",
  external_order_id: "10982",
  shipment_status: "label_purchased",
  created_at: "2026-07-17T15:30:00.000Z",
  ship_date: "2026-07-18T00:00:00.000Z",
  carrier_id: "se-123456",
  service_code: "ups_ground",
  tracking_number: "1Z999AA10123456784",
  ship_to: {
    name: "Maya Chen",
    email: "maya@example.com",
    phone: "+1-555-0100",
  },
  packages: [
    {
      products: [
        {
          name: "Canvas Tote",
          quantity: 2,
          sku: "TOTE-NAT",
        },
      ],
    },
  ],
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

async function requestBody(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  return input instanceof Request
    ? input.clone().json<Record<string, unknown>>()
    : (JSON.parse(String(init?.body)) as Record<string, unknown>);
}

function workerRequest(path: string, body: unknown) {
  return exports.default.fetch(turnRequest(path, body));
}

function turnRequest(path: string, body: unknown) {
  return new Request(`https://worker.test${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.BACKEND_AUTH_TOKEN}`,
      "content-type": "application/json",
      "x-resolve-tenant": env.TENANT_KEY,
      "x-resolve-anthropic-key": "anthropic-test",
      "x-resolve-anthropic-model": "claude-test",
      "x-resolve-anthropic-effort": "medium",
      "x-resolve-woo-solution-peptides-url": "https://solutionpeptides.net",
      "x-resolve-woo-solution-peptides-key": "woo-sp-key",
      "x-resolve-woo-solution-peptides-secret": "woo-sp-secret",
      "x-resolve-woo-atomik-labz-url": "https://atomiklabz.com",
      "x-resolve-woo-atomik-labz-key": "woo-atomik-key",
      "x-resolve-woo-atomik-labz-secret": "woo-atomik-secret",
      "x-resolve-shipstation-mode": "v2",
      "x-resolve-shipstation-v2-key": "shipstation-test",
    },
    body: JSON.stringify(body),
  });
}

function fakeKnowledgeEnvironment() {
  const run = vi.fn(async () => ({
    data: [Array.from({ length: 1_024 }, () => 0.25)],
  }));
  const query = vi.fn(async () => ({
    matches: [{ id: "vec_returns_0", score: 0.98 }],
    count: 1,
  }));
  const fakeEnv = {
    DB: env.DB,
    AI: { run },
    KNOWLEDGE_INDEX: {
      query,
      upsert: vi.fn(),
      deleteByIds: vi.fn(),
    },
    KNOWLEDGE_BUCKET: {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    },
    KNOWLEDGE_INDEX_QUEUE: { send: vi.fn() },
    REQUEST_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    BACKEND_AUTH_TOKEN: env.BACKEND_AUTH_TOKEN,
    TENANT_KEY: env.TENANT_KEY,
    WOO_SOLUTION_PEPTIDES_BASE_URL: env.WOO_SOLUTION_PEPTIDES_BASE_URL,
    WOO_ATOMIK_LABZ_BASE_URL: env.WOO_ATOMIK_LABZ_BASE_URL,
    CF_ACCESS_TEAM_DOMAIN: env.CF_ACCESS_TEAM_DOMAIN,
    CF_ACCESS_AUD: env.CF_ACCESS_AUD,
    PHONE_CACHE_HMAC_KEY: env.PHONE_CACHE_HMAC_KEY,
  } as unknown as Env;
  return { fakeEnv, query, run };
}

async function seedActiveKnowledgeChunk(): Promise<void> {
  const now = "2026-07-21T12:00:00.000Z";
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO knowledge_documents
          (id, filename, active_version_id, pending_version_id,
           deletion_status, deletion_error, delete_attempts,
           delete_updated_at, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, NULL, NULL, 0, NULL, ?, ?)`,
    ).bind("doc_returns", "returns.md", now, now),
    env.DB.prepare(
      `INSERT INTO knowledge_versions
          (id, document_id, filename, expected_active_version_id,
           candidate_r2_key, r2_key, content_sha256, status, chunk_count,
           created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, 'active', 1, ?, ?)`,
    ).bind(
      "ver_returns",
      "doc_returns",
      "returns.md",
      "candidates/doc_returns/ver_returns.md",
      "documents/doc_returns/ver_returns.md",
      "a".repeat(64),
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO knowledge_chunks
          (id, version_id, heading_path, ordinal, content, vector_id)
         VALUES (?, ?, ?, 0, ?, ?)`,
    ).bind(
      "chunk_returns",
      "ver_returns",
      JSON.stringify(["Returns", "Approval"]),
      "Approve only after identity verification.",
      "vec_returns_0",
    ),
    env.DB.prepare(
      "UPDATE knowledge_documents SET active_version_id = ? WHERE id = ?",
    ).bind("ver_returns", "doc_returns"),
  ]);
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM write_proposals"),
    env.DB.prepare("DELETE FROM pending_turns"),
    env.DB.prepare("DELETE FROM tool_runs"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM conversations"),
    env.DB.prepare("DELETE FROM knowledge_documents"),
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Resolve operations expansion integration", () => {
  it("uses a phone match to fetch and cite its ShipStation order", async () => {
    let anthropicCalls = 0;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input, init) => {
        const url =
          input instanceof Request
            ? new URL(input.url)
            : new URL(String(input));
        if (url.hostname === "api.anthropic.com") {
          anthropicCalls += 1;
          const body = await requestBody(input, init);
          if (anthropicCalls === 1) {
            return Response.json(
              anthropicMessage(
                [
                  {
                    type: "tool_use",
                    id: "tool_phone",
                    name: "shipstation_find_customer_by_phone",
                    input: { phone: "+1 (555) 0100" },
                  },
                ],
                "tool_use",
              ),
            );
          }
          if (anthropicCalls === 2) {
            const messages = body.messages as Array<{
              content: Array<{ content?: string; type: string }>;
            }>;
            const rawResult = messages.at(-1)?.content[0]?.content;
            expect(JSON.parse(rawResult ?? "{}")).toMatchObject({
              customers: [{ email: "maya@example.com" }],
              orders: [
                {
                  providerId: shipstationShipment.shipment_id,
                  orderNumber: "10982",
                },
              ],
              incomplete: false,
            });
            return Response.json(
              anthropicMessage(
                [
                  {
                    type: "tool_use",
                    id: "tool_order",
                    name: "shipstation_get_order",
                    input: { providerId: shipstationShipment.shipment_id },
                  },
                ],
                "tool_use",
              ),
            );
          }
          return Response.json(
            anthropicMessage(
              [{ type: "text", text: "Order 10982 is ready to ship." }],
              "end_turn",
            ),
          );
        }
        if (url.pathname === "/v2/shipments") {
          return Response.json({
            shipments: [shipstationShipment],
            total: 1,
            pages: 1,
          });
        }
        if (
          url.pathname === `/v2/shipments/${shipstationShipment.shipment_id}`
        ) {
          return Response.json(shipstationShipment);
        }
        throw new Error(`Unexpected request to ${url.toString()}`);
      });
    vi.stubGlobal("fetch", fetchMock);

    const response = await workerRequest("/v1/turn", {
      message: "Find the caller and their order from +1 (555) 0100.",
      ticket,
      agent: { id: 9, name: "Agent" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      kind: "assistant_message",
      content: "Order 10982 is ready to ship.",
      citations: [
        {
          provider: "shipstation",
          providerId: shipstationShipment.shipment_id,
        },
      ],
      toolEvents: [
        { toolName: "shipstation_find_customer_by_phone", status: "succeeded" },
        { toolName: "shipstation_get_order", status: "succeeded" },
      ],
    });
    expect(anthropicCalls).toBe(3);
  });

  it("preserves incomplete status after the bounded phone scan", async () => {
    let anthropicCalls = 0;
    let shipstationCalls = 0;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input, init) => {
        const url =
          input instanceof Request
            ? new URL(input.url)
            : new URL(String(input));
        if (url.hostname === "api.anthropic.com") {
          anthropicCalls += 1;
          if (anthropicCalls === 1) {
            return Response.json(
              anthropicMessage(
                [
                  {
                    type: "tool_use",
                    id: "tool_phone",
                    name: "shipstation_find_customer_by_phone",
                    input: { phone: "+1 (555) 0199" },
                  },
                ],
                "tool_use",
              ),
            );
          }
          const body = await requestBody(input, init);
          const messages = body.messages as Array<{
            content: Array<{ content?: string; type: string }>;
          }>;
          const rawResult = messages.at(-1)?.content[0]?.content;
          expect(JSON.parse(rawResult ?? "{}")).toMatchObject({
            customers: [],
            orders: [],
            searchedRecords: 0,
            incomplete: true,
            apiVersion: "v2",
          });
          return Response.json(
            anthropicMessage(
              [
                {
                  type: "text",
                  text: "No match was found in the bounded scan; older records may remain.",
                },
              ],
              "end_turn",
            ),
          );
        }
        if (url.pathname === "/v2/shipments") {
          shipstationCalls += 1;
          return Response.json({ shipments: [], total: 600, pages: 6 });
        }
        throw new Error(`Unexpected request to ${url.toString()}`);
      });
    vi.stubGlobal("fetch", fetchMock);

    const response = await workerRequest("/v1/turn", {
      message: "Find the caller from +1 (555) 0199.",
      ticket,
      agent: { id: 9, name: "Agent" },
    });

    expect(response.status).toBe(200);
    expect(shipstationCalls).toBe(5);
    await expect(response.json()).resolves.toMatchObject({
      kind: "assistant_message",
      content: expect.stringContaining("older records may remain"),
    });
  });

  it("uses an existing voicemail transcript to suggest fields when AI is unavailable", async () => {
    let modelCalls = 0;
    let voicemailHandle: string | undefined;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input, init) => {
        const url =
          input instanceof Request
            ? new URL(input.url)
            : new URL(String(input));
        if (url.hostname !== "api.anthropic.com") {
          throw new Error(
            `Workers AI fallback made an unexpected fetch: ${url}`,
          );
        }
        modelCalls += 1;
        const body = await requestBody(input, init);
        if (modelCalls === 1) {
          return Response.json(
            anthropicMessage(
              [
                {
                  type: "tool_use",
                  id: "tool_voicemails",
                  name: "zendesk_list_voicemails",
                  input: { ticketId: 8421 },
                },
              ],
              "tool_use",
            ),
          );
        }
        const messages = body.messages as Array<{
          content: Array<{ content?: string; type: string }>;
        }>;
        const rawResult = messages.at(-1)?.content[0]?.content;
        if (modelCalls === 2) {
          const compact = JSON.parse(rawResult ?? "{}") as {
            voicemails: Array<{ handle: string }>;
          };
          voicemailHandle = compact.voicemails[0]?.handle;
          expect(voicemailHandle).toMatch(/^vm_/);
          return Response.json(
            anthropicMessage(
              [
                {
                  type: "tool_use",
                  id: "tool_transcript",
                  name: "zendesk_transcribe_voicemail",
                  input: { handle: voicemailHandle },
                },
              ],
              "tool_use",
            ),
          );
        }
        expect(JSON.parse(rawResult ?? "{}")).toMatchObject({
          preview: "Please mark this ticket for a callback.",
          source: "zendesk_existing",
          status: "complete",
        });
        return Response.json(
          anthropicMessage(
            [
              {
                type: "tool_use",
                id: "tool_write",
                name: "zendesk_update_ticket_custom_fields",
                input: {
                  ticketId: 8421,
                  recordVersion: "version-1",
                  before: { "123": "pending" },
                  changes: { "123": "callback" },
                },
              },
            ],
            "tool_use",
          ),
        );
      });
    vi.stubGlobal("fetch", fetchMock);

    const first = await workerRequest("/v1/turn", {
      message: "Review the voicemail and suggest the ticket fields.",
      ticket,
      agent: { id: 9, name: "Agent" },
    });
    const delegated = await first.json<{ turnId: string }>();
    const response = await workerRequest("/v1/turn/continue", {
      turnId: delegated.turnId,
      results: [
        {
          toolUseId: "tool_voicemails",
          toolName: "zendesk_list_voicemails",
          output: {
            voicemails: [
              {
                ticketId: 8421,
                commentId: 99,
                recordingUrl: "https://recordings.example/99.mp3",
                transcriptionText: "Please mark this ticket for a callback.",
                createdAt: "2026-07-20T12:00:00.000Z",
              },
            ],
            citations: [
              {
                provider: "zendesk",
                label: "Ticket 8421",
                providerId: "8421",
                url: "https://example.zendesk.com/agent/tickets/8421",
              },
            ],
          },
          isError: false,
        },
      ],
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      kind: "action_confirmation_required",
      capability: expect.stringMatching(/^confirm_[0-9a-f]{64}$/),
      proposal: {
        action: "zendesk_update_ticket_custom_fields",
        targetId: 8421,
        before: { "123": "pending" },
        changes: { "123": "callback" },
      },
    });
    expect(modelCalls).toBe(3);
    expect(voicemailHandle).toMatch(/^vm_/);
  });

  it("searches production knowledge through fetch and reloads its persisted citation", async () => {
    await seedActiveKnowledgeChunk();
    const { fakeEnv, query, run } = fakeKnowledgeEnvironment();
    let modelCalls = 0;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input, init) => {
        const url =
          input instanceof Request
            ? new URL(input.url)
            : new URL(String(input));
        if (url.hostname !== "api.anthropic.com") {
          throw new Error(`Unexpected external request to ${url.toString()}`);
        }
        modelCalls += 1;
        if (modelCalls === 1) {
          return Response.json(
            anthropicMessage(
              [
                {
                  type: "tool_use",
                  id: "tool_knowledge",
                  name: "knowledge_search",
                  input: {
                    query: "How should this return be approved?",
                    brand: "Solution Peptides",
                    workflowCategory: "returns",
                  },
                },
              ],
              "tool_use",
            ),
          );
        }
        const body = await requestBody(input, init);
        expect(JSON.stringify(body.messages)).toContain(
          "BEGIN untrusted knowledge_context",
        );
        expect(JSON.stringify(body.messages)).toContain(
          "Approve only after identity verification.",
        );
        return Response.json(
          anthropicMessage(
            [
              {
                type: "text",
                text: "Follow the cited approval workflow.",
              },
            ],
            "end_turn",
          ),
        );
      });
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      turnRequest("/v1/turn", {
        message: "How should I approve this return?",
        ticket,
        agent: { id: 9, name: "Agent" },
      }) as Parameters<typeof worker.fetch>[0],
      fakeEnv,
    );
    const completed = await response.json<{
      conversationId: string;
      citations: unknown[];
    }>();

    expect(response.status).toBe(200);
    expect(completed.citations).toEqual([
      {
        provider: "knowledge",
        providerId: "chunk_returns",
        label: "returns.md — Returns > Approval",
        url: "https://worker.test/admin/knowledge#document-doc_returns",
      },
    ]);
    expect(run).toHaveBeenCalledWith("@cf/qwen/qwen3-embedding-0.6b", {
      queries: ["How should this return be approved?"],
    });
    expect(query).toHaveBeenCalledWith(expect.any(Array), {
      topK: 10,
      returnMetadata: "indexed",
      filter: {
        brand: "Solution Peptides",
        workflowCategory: "returns",
      },
    });

    const historyResponse = await worker.fetch(
      new Request(
        `https://worker.test/v1/conversations/${completed.conversationId}/messages`,
        {
          headers: {
            authorization: `Bearer ${env.BACKEND_AUTH_TOKEN}`,
            "x-resolve-tenant": env.TENANT_KEY,
          },
        },
      ),
      fakeEnv,
    );
    const history = await historyResponse.json<{
      messages: Array<{ citations: unknown[] }>;
    }>();

    expect(historyResponse.status).toBe(200);
    expect(history.messages.at(-1)?.citations).toEqual(completed.citations);
    expect(modelCalls).toBe(2);
  });

  it("rejects an admin upload authenticated only with the Zendesk token", async () => {
    const response = await exports.default.fetch(
      new Request("https://worker.test/admin/api/knowledge", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.BACKEND_AUTH_TOKEN}`,
          "content-length": "10",
          "content-type": "multipart/form-data; boundary=test",
        },
        body: "--test--",
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      kind: "error",
      code: "unauthorized",
    });
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM knowledge_documents",
    ).first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("loads the expansion migrations after the existing schema", () => {
    expect(env.TEST_MIGRATIONS.map((migration) => migration.name)).toEqual([
      "0001_conversations.sql",
      "0002_message_evidence.sql",
      "0003_operations_expansion.sql",
      "0004_write_proposals.sql",
      "0005_knowledge.sql",
    ]);
  });
});
