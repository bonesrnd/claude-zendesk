import { describe, expect, it, vi } from "vitest";

import type { ZafClient } from "../../types/zaf";
import { getTicketContext } from "./ticket-context";

describe("getTicketContext", () => {
  it("returns bounded active ticket and agent context", async () => {
    const conversation = Array.from({ length: 31 }, (_, index) => ({
      author: { name: `Author ${index}` },
      message: { content: "x".repeat(20_100) },
      timestamp: "2026-07-18T12:00:00.000Z",
      public: true,
    }));
    const client = {
      get: vi.fn().mockResolvedValue({
        "ticket.id": 8421,
        "ticket.subject": "Where is my order?",
        "ticket.requester": {
          id: 77,
          name: "Maya Chen",
          email: "maya@example.com",
        },
        "ticket.brand": {
          id: 123,
          name: "Solution Peptides",
          subdomain: "solutionpeptides",
        },
        "ticket.conversation": conversation,
        currentUser: { id: 9, name: "Agent" },
      }),
    } as unknown as ZafClient;

    const context = await getTicketContext(client);

    expect(context.ticket.recentConversation).toHaveLength(30);
    expect(context.ticket.recentConversation[0]?.authorName).toBe("Author 1");
    expect(context.ticket.recentConversation[0]?.body).toHaveLength(20_000);
    expect(context.ticket.brand).toEqual({
      id: 123,
      name: "Solution Peptides",
      subdomain: "solutionpeptides",
    });
    expect(context.agent).toEqual({ id: 9, name: "Agent" });
  });

  it("rejects malformed host data", async () => {
    const client = {
      get: vi.fn().mockResolvedValue({
        "ticket.id": "not-a-number",
      }),
    } as unknown as ZafClient;

    await expect(getTicketContext(client)).rejects.toThrow();
  });

  it("accepts valid Zendesk events with null message content", async () => {
    const client = {
      get: vi.fn().mockResolvedValue({
        "ticket.id": 8421,
        "ticket.subject": null,
        "ticket.requester": {
          id: 77,
          name: "Maya Chen",
          email: null,
        },
        "ticket.brand": {
          id: 123,
          name: "Solution Peptides",
          subdomain: null,
        },
        "ticket.conversation": [
          {
            author: { name: "System" },
            message: { content: null, contentType: null },
            timestamp: "2026-07-20T12:00:00Z",
          },
        ],
        currentUser: { id: 9, name: "Agent" },
      }),
    } as unknown as ZafClient;

    const context = await getTicketContext(client);

    expect(context.ticket.subject).toBe("");
    expect(context.ticket.requester).toEqual({
      id: 77,
      name: "Maya Chen",
    });
    expect(context.ticket.brand).toEqual({
      id: 123,
      name: "Solution Peptides",
    });
    expect(context.ticket.recentConversation[0]?.body).toBe("");
  });
});
