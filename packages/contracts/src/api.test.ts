import { describe, expect, it } from "vitest";

import { TurnRequestSchema, TurnResponseSchema } from "./api";

describe("TurnRequestSchema", () => {
  it("rejects unknown keys", () => {
    const result = TurnRequestSchema.safeParse({
      conversationId: "conv_1",
      message: "Find the latest order",
      ticket: {
        ticketId: 8421,
        subject: "Where is my order?",
        requester: { id: 77, name: "Maya Chen", email: "maya@example.com" },
        recentConversation: [],
      },
      agent: { id: 9, name: "A. Agent" },
      unexpected: true,
    });

    expect(result.success).toBe(false);
  });

  it("accepts bounded ticket context", () => {
    const result = TurnRequestSchema.safeParse({
      message: "Find the latest order",
      ticket: {
        ticketId: 8421,
        subject: "Where is my order?",
        requester: { id: 77, name: "Maya Chen", email: "maya@example.com" },
        recentConversation: [],
      },
      agent: { id: 9, name: "A. Agent" },
    });

    expect(result.success).toBe(true);
  });
});

describe("TurnResponseSchema", () => {
  it("accepts a delegated tool response", () => {
    const response = TurnResponseSchema.parse({
      kind: "delegated_tool_request",
      turnId: "turn_1",
      requests: [
        {
          toolUseId: "tool_1",
          toolName: "zendesk_search_tickets",
          input: { query: "requester:77 status:solved" },
        },
      ],
    });

    expect(response.kind).toBe("delegated_tool_request");
  });

  it("rejects error codes not exposed by the API", () => {
    expect(
      TurnResponseSchema.safeParse({
        kind: "error",
        code: "internal_stack_trace",
        message: "unsafe",
        retryable: false,
      }).success,
    ).toBe(false);
  });

  it("accepts validated partial work on orchestration limits", () => {
    expect(
      TurnResponseSchema.parse({
        kind: "error",
        code: "orchestration_limit",
        message: "Limit reached",
        retryable: true,
        partial: {
          conversationId: "conv_1",
          messageId: "msg_1",
          content: "One lookup completed.",
          citations: [],
          toolEvents: [],
        },
      }),
    ).toMatchObject({
      kind: "error",
      partial: {
        conversationId: "conv_1",
        content: "One lookup completed.",
      },
    });
  });
});
