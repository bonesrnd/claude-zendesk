import { describe, expect, it } from "vitest";

import {
  AnthropicEffortSchema,
  AnthropicModelSchema,
  TurnRequestSchema,
  TurnResponseSchema,
} from "./api";

describe("Anthropic admin settings", () => {
  it("accepts supported effort levels", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(AnthropicEffortSchema.parse(effort)).toBe(effort);
    }
    expect(AnthropicEffortSchema.safeParse("turbo").success).toBe(false);
  });

  it("accepts Claude model identifiers and rejects arbitrary values", () => {
    expect(AnthropicModelSchema.parse("claude-sonnet-5")).toBe(
      "claude-sonnet-5",
    );
    expect(AnthropicModelSchema.safeParse("https://evil.example").success).toBe(
      false,
    );
  });
});

describe("TurnRequestSchema", () => {
  it("rejects unknown keys", () => {
    const result = TurnRequestSchema.safeParse({
      conversationId: "conv_1",
      message: "Find the latest order",
      ticket: {
        ticketId: 8421,
        subject: "Where is my order?",
        requester: { id: 77, name: "Maya Chen", email: "maya@example.com" },
        brand: { id: 123, name: "Solution Peptides" },
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
        brand: { id: 123, name: "Solution Peptides" },
        recentConversation: [],
      },
      agent: { id: 9, name: "A. Agent" },
    });

    expect(result.success).toBe(true);
  });
});

describe("TurnResponseSchema", () => {
  it("accepts an action confirmation response without a delegated write", () => {
    const response = TurnResponseSchema.parse({
      kind: "action_confirmation_required",
      conversationId: "conv_1",
      capability: `confirm_${"a".repeat(64)}`,
      proposal: {
        id: "turn_1",
        action: "zendesk_update_customer_profile",
        targetId: 77,
        before: { phone: "+15551230000" },
        changes: { phone: "+15559870000" },
        expiresAt: "2026-07-21T12:10:00.000Z",
      },
    });

    expect(response).toMatchObject({
      kind: "action_confirmation_required",
      proposal: { id: "turn_1", targetId: 77 },
    });
    expect(response).not.toHaveProperty("requests");
  });

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
