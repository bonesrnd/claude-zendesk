import { describe, expect, it, vi } from "vitest";

import type { ZafClient } from "../types/zaf";
import { WorkerClient, type VisibleSettings } from "./worker-client";

const settings: VisibleSettings = {
  workerUrl: "https://resolve.example.workers.dev",
  zendeskSubdomain: "example",
  anthropicModel: "claude-test",
  wooBaseUrl: "https://store.example",
  shipstationMode: "v2",
};

describe("WorkerClient", () => {
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
        "x-resolve-woo-key": "{{setting.woo_consumer_key}}",
        "x-resolve-woo-secret": "{{setting.woo_consumer_secret}}",
      },
    });
    expect(options.data).not.toContain("anthropic_api_key");
    expect(options.data).not.toContain("woo_consumer_secret");
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
