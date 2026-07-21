import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ticket = {
  ticketId: 8421,
  subject: "Where is my order?",
  requester: { id: 77, name: "Maya Chen", email: "maya@example.com" },
  brand: { id: 123, name: "Solution Peptides" },
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
        "x-resolve-anthropic-effort": "medium",
        "x-resolve-woo-solution-peptides-url": "https://solutionpeptides.net",
        "x-resolve-woo-solution-peptides-key": "woo-sp-key",
        "x-resolve-woo-solution-peptides-secret": "woo-sp-secret",
        "x-resolve-woo-atomik-labz-url": "https://atomiklabz.com",
        "x-resolve-woo-atomik-labz-key": "woo-atomik-key",
        "x-resolve-woo-atomik-labz-secret": "woo-atomik-secret",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM write_proposals"),
    env.DB.prepare("DELETE FROM pending_turns"),
    env.DB.prepare("DELETE FROM tool_runs"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM conversations"),
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /v1/turn", () => {
  it("returns a confirmation proposal instead of delegating a write", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () =>
        Response.json(
          anthropicMessage(
            [
              {
                type: "tool_use",
                id: "tool_write",
                name: "zendesk_update_customer_profile",
                input: {
                  userId: 77,
                  recordVersion: "2026-07-21T12:00:00.000Z",
                  before: { phone: "+15551230000" },
                  changes: { phone: "+15559870000" },
                },
              },
            ],
            "tool_use",
          ),
        ),
      ),
    );

    const response = await workerRequest("/v1/turn", {
      message: "Update the customer phone",
      ticket,
      agent: { id: 9, name: "Agent" },
    });
    const body = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      kind: "action_confirmation_required",
      conversationId: expect.stringMatching(/^conv_/),
      capability: expect.stringMatching(/^confirm_[0-9a-f]{64}$/),
      proposal: {
        action: "zendesk_update_customer_profile",
        targetId: 77,
        before: { phone: "+15551230000" },
        changes: { phone: "+15559870000" },
      },
    });
    expect(body).not.toHaveProperty("requests");
    const capability = String(body.capability);
    const stored = await env.DB.prepare(
      "SELECT agent_id, status, capability_hash FROM write_proposals",
    ).first<Record<string, unknown>>();
    expect(stored).toMatchObject({ agent_id: 9, status: "pending" });
    expect(stored?.capability_hash).not.toBe(capability);
    const messages = await env.DB.prepare("SELECT content FROM messages").all();
    expect(JSON.stringify(messages.results)).not.toContain(capability);
    expect(JSON.stringify(log.mock.calls)).not.toContain(capability);
  });

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

  it("rejects unsupported Anthropic effort values before calling the API", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await workerRequest(
      "/v1/turn",
      {
        message: "Check the latest order",
        ticket,
        agent: { id: 9, name: "Agent" },
      },
      { "x-resolve-anthropic-effort": "turbo" },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      kind: "error",
      code: "configuration_error",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects tickets from an unmapped brand before using WooCommerce", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await workerRequest("/v1/turn", {
      message: "Check the latest order",
      ticket: {
        ...ticket,
        brand: { id: 999, name: "Unknown Brand" },
      },
      agent: { id: 9, name: "Agent" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      kind: "error",
      code: "configuration_error",
    });
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("chunks a long retained transcript after delegated pause and resume", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const completeTranscript = `${"A".repeat(6_500)} LATE_MARKER ${"B".repeat(1_000)}`;
    const citation = {
      provider: "zendesk",
      label: "Ticket 7314",
      providerId: "7314",
      url: "https://example.zendesk.com/agent/tickets/7314",
    };
    const voicemails = Array.from({ length: 30 }, (_, index) => ({
      ticketId: 7314,
      commentId: index + 1,
      recordingUrl: `https://recordings.example/${index + 1}.mp3`,
      transcriptionText: `${completeTranscript}:${index}`,
      createdAt: "2026-07-20T12:00:00.000Z",
    }));
    let voicemailHandle: string | undefined;
    let transcriptHandle: string | undefined;
    let transcriptLength: number | undefined;
    let retrievedLateContent = false;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input, init) => {
        const body =
          input instanceof Request
            ? await input.clone().json<Record<string, unknown>>()
            : (JSON.parse(String(init?.body)) as Record<string, unknown>);
        requestBodies.push(body);
        if (requestBodies.length === 1) {
          return Response.json(
            anthropicMessage(
              [
                {
                  type: "tool_use",
                  id: "tool_voicemails",
                  name: "zendesk_list_voicemails",
                  input: { ticketId: 7314 },
                },
              ],
              "tool_use",
            ),
          );
        }
        if (requestBodies.length === 2) {
          const messages = body.messages as Array<{
            content: Array<{ content?: string; type: string }>;
          }>;
          const rawResult = messages.at(-1)?.content[0]?.content;
          if (!rawResult) throw new Error("Missing compact voicemail result");
          const compact = JSON.parse(rawResult) as {
            voicemails: Array<Record<string, unknown>>;
          };
          voicemailHandle = String(compact.voicemails[0]?.handle);
          expect(voicemailHandle).toMatch(/^vm_/);
          expect(compact.voicemails).toHaveLength(30);
          expect(compact.voicemails[0]).not.toHaveProperty("recordingUrl");
          expect(compact.voicemails[0]).not.toHaveProperty("transcriptionText");
          expect(rawResult).not.toContain("COMPLETE_MARKER");
          expect(rawResult.length).toBeLessThan(6_000);
          return Response.json(
            anthropicMessage(
              [
                {
                  type: "tool_use",
                  id: "tool_transcribe",
                  name: "zendesk_transcribe_voicemail",
                  input: { handle: voicemailHandle },
                },
              ],
              "tool_use",
            ),
          );
        }
        if (requestBodies.length === 3) {
          const messages = body.messages as Array<{
            content: Array<{ content?: string; type: string }>;
          }>;
          const rawResult = messages.at(-1)?.content[0]?.content;
          if (!rawResult) throw new Error("Missing compact transcript result");
          const compact = JSON.parse(rawResult) as Record<string, unknown>;
          transcriptHandle = String(compact.handle);
          transcriptLength = Number(compact.transcriptLength);
          expect(transcriptHandle).toMatch(/^vmt_/);
          expect(compact).toMatchObject({
            preview: expect.any(String),
            status: "truncated",
            source: "zendesk_existing",
          });
          expect(String(compact.preview).length).toBeLessThanOrEqual(1_000);
          expect(compact).not.toHaveProperty("text");
          expect(compact).not.toHaveProperty("content");
          expect(rawResult).not.toContain("LATE_MARKER");
          expect(rawResult.length).toBeLessThan(6_000);
          return Response.json(
            anthropicMessage(
              [
                {
                  type: "tool_use",
                  id: "tool_pause",
                  name: "zendesk_get_requester_tickets",
                  input: { requesterId: 77, limit: 1 },
                },
              ],
              "tool_use",
            ),
          );
        }
        if (requestBodies.length === 4) {
          if (!transcriptHandle) throw new Error("Missing transcript handle");
          return Response.json(
            anthropicMessage(
              [
                {
                  type: "tool_use",
                  id: "tool_chunk",
                  name: "zendesk_read_voicemail_transcript_chunk",
                  input: {
                    handle: transcriptHandle,
                    offset: 6_400,
                    length: 300,
                  },
                },
              ],
              "tool_use",
            ),
          );
        }
        if (requestBodies.length === 5) {
          const messages = body.messages as Array<{
            content: Array<{ content?: string; is_error?: boolean }>;
          }>;
          const rawResult = messages.at(-1)?.content[0]?.content;
          if (!rawResult) throw new Error("Missing transcript chunk result");
          const chunk = JSON.parse(rawResult) as Record<string, unknown>;
          expect(chunk).toMatchObject({
            handle: transcriptHandle,
            offset: 6_400,
            status: "more",
          });
          expect(String(chunk.text)).toContain("LATE_MARKER");
          expect(chunk).not.toHaveProperty("content");
          retrievedLateContent = true;
          return Response.json(
            anthropicMessage(
              [
                {
                  type: "tool_use",
                  id: "tool_out_of_range",
                  name: "zendesk_read_voicemail_transcript_chunk",
                  input: {
                    handle: transcriptHandle,
                    offset: transcriptLength,
                    length: 100,
                  },
                },
              ],
              "tool_use",
            ),
          );
        }
        if (requestBodies.length === 6) {
          const messages = body.messages as Array<{
            content: Array<{ is_error?: boolean }>;
          }>;
          expect(messages.at(-1)?.content[0]?.is_error).toBe(true);
          return Response.json(
            anthropicMessage(
              [{ type: "text", text: "The later transcript was retrieved." }],
              "end_turn",
            ),
          );
        }
        throw new Error("Unexpected non-model fetch");
      });
    vi.stubGlobal("fetch", fetchMock);

    const first = await workerRequest("/v1/turn", {
      message: "Review the voicemail",
      ticket,
      agent: { id: 9, name: "Agent" },
    });
    const delegated = await first.json<{ turnId: string }>();

    const firstContinue = await workerRequest("/v1/turn/continue", {
      turnId: delegated.turnId,
      results: [
        {
          toolUseId: "tool_voicemails",
          toolName: "zendesk_list_voicemails",
          output: {
            voicemails,
            citations: [citation],
          },
          isError: false,
        },
      ],
    });

    expect(firstContinue.status).toBe(200);
    const pausedAgain = await firstContinue.json<{
      kind: string;
      turnId: string;
      requests: Array<{ toolName: string }>;
    }>();
    expect(pausedAgain).toMatchObject({
      kind: "delegated_tool_request",
      requests: [{ toolName: "zendesk_get_requester_tickets" }],
    });

    const final = await workerRequest("/v1/turn/continue", {
      turnId: pausedAgain.turnId,
      results: [
        {
          toolUseId: "tool_pause",
          toolName: "zendesk_get_requester_tickets",
          output: { tickets: [], citations: [] },
          isError: false,
        },
      ],
    });

    expect(final.status).toBe(200);
    await expect(final.json()).resolves.toMatchObject({
      content: "The later transcript was retrieved.",
      citations: [{ providerId: "7314" }],
    });
    expect(voicemailHandle).toMatch(/^vm_/);
    expect(transcriptHandle).toMatch(/^vmt_/);
    expect(transcriptLength).toBe(completeTranscript.length + 2);
    expect(retrievedLateContent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it.each([
    {
      label: "voicemail",
      toolName: "zendesk_transcribe_voicemail",
      input: { handle: "vm_12345678-1234-4234-8234-123456789abc" },
    },
    {
      label: "transcript chunk",
      toolName: "zendesk_read_voicemail_transcript_chunk",
      input: {
        handle: "vmt_12345678-1234-4234-8234-123456789abc",
        offset: 0,
        length: 100,
      },
    },
  ])("rejects an unrecognized $label handle", async ({ toolName, input }) => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const responses = [
      anthropicMessage(
        [
          {
            type: "tool_use",
            id: "tool_unrecognized",
            name: toolName,
            input,
          },
        ],
        "tool_use",
      ),
      anthropicMessage(
        [{ type: "text", text: "That voicemail is unavailable." }],
        "end_turn",
      ),
    ];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input, init) => {
        requestBodies.push(
          input instanceof Request
            ? await input.clone().json<Record<string, unknown>>()
            : (JSON.parse(String(init?.body)) as Record<string, unknown>),
        );
        const response = responses.shift();
        if (!response) throw new Error("Unexpected non-model fetch");
        return Response.json(response);
      });
    vi.stubGlobal("fetch", fetchMock);

    const response = await workerRequest("/v1/turn", {
      message: "Transcribe an unknown voicemail",
      ticket,
      agent: { id: 9, name: "Agent" },
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBodies.at(-1)).toMatchObject({
      messages: [
        expect.anything(),
        expect.anything(),
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_unrecognized",
              is_error: true,
            },
          ],
        },
      ],
    });
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
