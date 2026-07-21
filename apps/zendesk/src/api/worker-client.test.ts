import { describe, expect, it, vi } from "vitest";

import type { ZafClient } from "../types/zaf";
import {
  parseVisibleSettings,
  WorkerClient,
  type VisibleSettings,
} from "./worker-client";

const settings: VisibleSettings = {
  workerUrl: "https://resolve.example.workers.dev",
  workerHost: "resolve.example.workers.dev",
  zendeskSubdomain: "example",
  anthropicModel: "claude-test",
  anthropicEffort: "medium",
  wooSolutionPeptidesBaseUrl: "https://solutionpeptides.net",
  wooAtomikLabzBaseUrl: "https://atomiklabz.com",
  shipstationMode: "v2",
};

describe("WorkerClient", () => {
  it("posts dedicated action confirmation data", async () => {
    const request = vi.fn().mockResolvedValue({
      kind: "delegated_tool_request",
      turnId: "turn_1",
      requests: [
        {
          toolUseId: "tool_write",
          toolName: "zendesk_update_customer_profile",
          input: {
            userId: 77,
            recordVersion: "version-1",
            before: { phone: "+15551230000" },
            changes: { phone: "+15559870000" },
          },
        },
      ],
    });
    const worker = new WorkerClient(
      { request } as unknown as ZafClient,
      settings,
    );

    await worker.confirmAction("turn_1", {
      capability: `confirm_${"a".repeat(64)}`,
      recordVersion: "version-1",
    });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://resolve.example.workers.dev/v1/actions/turn_1/confirm",
        type: "POST",
        data: JSON.stringify({
          capability: `confirm_${"a".repeat(64)}`,
          recordVersion: "version-1",
        }),
      }),
    );
  });

  it("loads persisted conversation history with a knowledge citation", async () => {
    const knowledgeCitation = {
      provider: "knowledge",
      label: "returns.md — Returns > Approval",
      providerId: "chunk_returns",
      url: "https://resolve.example.workers.dev/admin/knowledge#document-doc_returns",
    };
    const request = vi.fn().mockResolvedValue({
      conversation: {
        id: "conv_knowledge",
        tenantKey: "example",
        ticketId: 8421,
        createdAt: "2026-07-21T12:00:00.000Z",
        updatedAt: "2026-07-21T12:01:00.000Z",
        expiresAt: "2026-10-19T12:01:00.000Z",
      },
      messages: [
        {
          id: "msg_knowledge",
          conversationId: "conv_knowledge",
          role: "assistant",
          content: "Follow the cited approval workflow.",
          citations: [knowledgeCitation],
          toolEvents: [],
          createdAt: "2026-07-21T12:01:00.000Z",
        },
      ],
      toolRuns: [],
    });
    const worker = new WorkerClient(
      { request } as unknown as ZafClient,
      settings,
    );

    const history = await worker.getConversation("conv_knowledge");

    expect(history.messages[0]?.citations).toEqual([knowledgeCitation]);
  });

  it("defaults all non-secret single-tenant settings", () => {
    expect(parseVisibleSettings({})).toEqual({
      workerUrl: "https://resolve-orchestrator.bones-baa.workers.dev",
      workerHost: "resolve-orchestrator.bones-baa.workers.dev",
      zendeskSubdomain: "solutionpeptides",
      anthropicModel: "claude-sonnet-5",
      anthropicEffort: "medium",
      wooSolutionPeptidesBaseUrl: "https://solutionpeptides.net",
      wooAtomikLabzBaseUrl: "https://atomiklabz.com",
      shipstationMode: "auto",
    });
  });

  it("uses secure proxy placeholders without putting secrets in JSON", async () => {
    const request = vi.fn().mockResolvedValue({
      kind: "assistant_message",
      conversationId: "conv_1",
      messageId: "msg_1",
      content: "The order shipped.",
      citations: [],
      toolEvents: [],
    });
    const client = { request } as unknown as ZafClient;
    const worker = new WorkerClient(client, settings);

    await worker.startTurn({
      message: "Check the latest order",
      ticket: {
        ticketId: 8421,
        subject: "Where is my order?",
        requester: { id: 77, name: "Maya Chen" },
        brand: { id: 123, name: "Solution Peptides" },
        recentConversation: [],
      },
      agent: { id: 9, name: "Agent" },
    });

    const options = request.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      url: "https://resolve.example.workers.dev/v1/turn",
      type: "POST",
      secure: true,
      cors: false,
      timeout: 60_000,
      contentType: "application/json",
      headers: {
        authorization: "Bearer {{setting.backend_auth_token}}",
        "x-resolve-anthropic-key": "{{setting.anthropic_api_key}}",
        "x-resolve-anthropic-effort": "medium",
        "x-resolve-woo-solution-peptides-key":
          "{{setting.woo_solution_peptides_consumer_key}}",
        "x-resolve-woo-solution-peptides-secret":
          "{{setting.woo_solution_peptides_consumer_secret}}",
        "x-resolve-woo-atomik-labz-key":
          "{{setting.woo_atomik_labz_consumer_key}}",
        "x-resolve-woo-atomik-labz-secret":
          "{{setting.woo_atomik_labz_consumer_secret}}",
      },
    });
    expect(options.data).not.toContain("anthropic_api_key");
    expect(options.data).not.toContain("woo_solution_peptides_consumer_secret");
  });

  it("rejects malformed Worker responses", async () => {
    const client = {
      request: vi.fn().mockResolvedValue({ kind: "made_up" }),
    } as unknown as ZafClient;
    const worker = new WorkerClient(client, settings);

    await expect(
      worker.startTurn({
        message: "Check",
        ticket: {
          ticketId: 8421,
          subject: "",
          requester: { id: 77, name: "Maya" },
          brand: { id: 123, name: "Solution Peptides" },
          recentConversation: [],
        },
        agent: { id: 9, name: "Agent" },
      }),
    ).rejects.toThrow();
  });

  it("requires an HTTPS Worker URL", () => {
    const client = { request: vi.fn() } as unknown as ZafClient;

    expect(
      () =>
        new WorkerClient(client, {
          ...settings,
          workerUrl: "http://resolve.example.workers.dev",
        }),
    ).toThrow("Worker URL must use HTTPS");
  });
});
