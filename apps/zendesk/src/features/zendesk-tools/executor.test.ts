import type { DelegatedToolResponse } from "@resolve/contracts";
import { describe, expect, it, vi } from "vitest";

import type { ZafClient } from "../../types/zaf";
import { executeZendeskTool } from "./executor";

type DelegatedRequest = DelegatedToolResponse["requests"][number];

function request(toolName: string, input: unknown): DelegatedRequest {
  return {
    toolUseId: "tool_1",
    toolName,
    input,
  };
}

describe("executeZendeskTool", () => {
  it("searches requester tickets with a bounded query", async () => {
    const zafRequest = vi.fn().mockResolvedValue({
      results: [
        {
          id: 7314,
          subject: "Damaged item",
          status: "solved",
          created_at: "2026-01-01T12:00:00.000Z",
          updated_at: "2026-01-02T12:00:00.000Z",
          description: "Replacement sent",
        },
      ],
    });
    const client = { request: zafRequest } as unknown as ZafClient;

    const result = await executeZendeskTool(
      client,
      request("zendesk_get_requester_tickets", {
        requesterId: 77,
        limit: 10,
      }),
      "example",
    );

    const options = zafRequest.mock.calls[0]?.[0];
    const query = new URL(
      options.url,
      "https://example.zendesk.com",
    ).searchParams.get("query");
    expect(query).toContain("type:ticket");
    expect(query).toContain("requester:77");
    expect(options).toMatchObject({ type: "GET", autoRetry: true });
    expect(result).toMatchObject({
      toolUseId: "tool_1",
      isError: false,
      output: {
        tickets: [{ ticketId: 7314, snippet: "Replacement sent" }],
        citations: [
          {
            provider: "zendesk",
            providerId: "7314",
            url: "https://example.zendesk.com/agent/tickets/7314",
          },
        ],
      },
    });
  });

  it("forces solved status into pattern searches", async () => {
    const zafRequest = vi.fn().mockResolvedValue({ results: [] });
    const client = { request: zafRequest } as unknown as ZafClient;

    await executeZendeskTool(
      client,
      request("zendesk_search_solved_tickets", {
        terms: ["damaged item"],
        limit: 10,
      }),
      "example",
    );

    const query = new URL(
      zafRequest.mock.calls[0]?.[0].url,
      "https://example.zendesk.com",
    ).searchParams.get("query");
    expect(query).toContain("status:solved");
    expect(query).toContain('"damaged item"');
  });

  it("gets one ticket and compacts comments", async () => {
    const zafRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ticket: {
          id: 7314,
          subject: "Damaged item",
          status: "solved",
          created_at: "2026-01-01T12:00:00.000Z",
          updated_at: "2026-01-02T12:00:00.000Z",
          description: "Replacement sent",
        },
      })
      .mockResolvedValueOnce({
        comments: [
          {
            author_id: 22,
            plain_body: "We sent a replacement.",
            created_at: "2026-01-02T12:00:00.000Z",
            public: true,
            via: { source: { from: { name: "Support Agent" } } },
          },
        ],
      });
    const client = { request: zafRequest } as unknown as ZafClient;

    const result = await executeZendeskTool(
      client,
      request("zendesk_get_ticket", { ticketId: 7314 }),
      "example",
    );

    expect(zafRequest).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      output: {
        ticket: {
          ticketId: 7314,
          comments: [
            {
              authorName: "Support Agent",
              body: "We sent a replacement.",
              public: true,
            },
          ],
        },
      },
    });
  });

  it("refuses unregistered delegated tools", async () => {
    const client = { request: vi.fn() } as unknown as ZafClient;

    await expect(
      executeZendeskTool(
        client,
        request("zendesk_delete_ticket", { ticketId: 7314 }),
        "example",
      ),
    ).rejects.toThrow("Unsupported delegated tool");
  });
});
