import type { TurnResponse } from "@resolve/contracts";
import { describe, expect, it, vi } from "vitest";

import type { ActiveTicketContext } from "../ticket/ticket-context";
import { ChatController, type ChatWorker } from "./chat-controller";

const context: ActiveTicketContext = {
  ticket: {
    ticketId: 8421,
    subject: "Where is my order?",
    requester: { id: 77, name: "Maya Chen", email: "maya@example.com" },
    recentConversation: [],
  },
  agent: { id: 9, name: "Agent" },
};

function assistant(content: string): TurnResponse {
  return {
    kind: "assistant_message",
    conversationId: "conv_1",
    messageId: "msg_2",
    content,
    citations: [],
    toolEvents: [],
  };
}

function worker(overrides: Partial<ChatWorker> = {}): ChatWorker {
  return {
    startTurn: vi.fn(async () => assistant("Completed")),
    continueTurn: vi.fn(async () => assistant("Continued")),
    listConversations: vi.fn(async () => ({ conversations: [] })),
    getConversation: vi.fn(async () => ({
      conversation: {
        id: "conv_1",
        tenantKey: "tenant",
        ticketId: 8421,
        createdAt: "2026-07-18T12:00:00.000Z",
        updatedAt: "2026-07-18T12:00:00.000Z",
        expiresAt: "2026-10-16T12:00:00.000Z",
      },
      messages: [],
      toolRuns: [],
    })),
    ...overrides,
  };
}

describe("ChatController", () => {
  it("shows the user message before the Worker resolves", async () => {
    let resolve!: (response: TurnResponse) => void;
    const pending = new Promise<TurnResponse>((done) => {
      resolve = done;
    });
    const controller = new ChatController({
      worker: worker({ startTurn: vi.fn(async () => pending) }),
      executeZendeskTool: vi.fn(),
      now: () => new Date("2026-07-18T12:00:00.000Z"),
    });

    const send = controller.send("Check the latest order", context);

    expect(controller.getSnapshot()).toMatchObject({
      status: "submitting",
      messages: [{ role: "user", content: "Check the latest order" }],
    });
    resolve(assistant("The order shipped."));
    await send;
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      messages: [
        { role: "user" },
        { role: "assistant", content: "The order shipped." },
      ],
    });
  });

  it("executes delegated tools and continues the same turn", async () => {
    const delegated: TurnResponse = {
      kind: "delegated_tool_request",
      turnId: "turn_1",
      requests: [
        {
          toolUseId: "tool_1",
          toolName: "zendesk_get_ticket",
          input: { ticketId: 7314 },
        },
      ],
    };
    const continueTurn = vi.fn(async () => assistant("Prior ticket found."));
    const executeZendeskTool = vi.fn(async (request) => ({
      toolUseId: request.toolUseId,
      toolName: request.toolName,
      output: { ticket: null, citations: [] },
      isError: false,
    }));
    const controller = new ChatController({
      worker: worker({
        startTurn: vi.fn(async () => delegated),
        continueTurn,
      }),
      executeZendeskTool,
    });

    await controller.send("Check prior tickets", context);

    expect(executeZendeskTool).toHaveBeenCalledTimes(1);
    expect(continueTurn).toHaveBeenCalledWith({
      turnId: "turn_1",
      results: [
        {
          toolUseId: "tool_1",
          toolName: "zendesk_get_ticket",
          output: { ticket: null, citations: [] },
          isError: false,
        },
      ],
    });
    expect(controller.getSnapshot().messages.at(-1)?.content).toBe(
      "Prior ticket found.",
    );
  });

  it("stops after six delegated continuations", async () => {
    const delegated: TurnResponse = {
      kind: "delegated_tool_request",
      turnId: "turn_loop",
      requests: [
        {
          toolUseId: "tool_loop",
          toolName: "zendesk_get_ticket",
          input: { ticketId: 7314 },
        },
      ],
    };
    const controller = new ChatController({
      worker: worker({
        startTurn: vi.fn(async () => delegated),
        continueTurn: vi.fn(async () => delegated),
      }),
      executeZendeskTool: vi.fn(async (request) => ({
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        output: { ticket: null, citations: [] },
        isError: false,
      })),
    });

    await controller.send("Loop", context);

    expect(controller.getSnapshot()).toMatchObject({
      status: "error",
      error: {
        message: "Resolve reached the delegated tool limit.",
      },
    });
  });

  it("preserves the timeline when a request fails", async () => {
    const controller = new ChatController({
      worker: worker({
        startTurn: vi.fn(async () => {
          throw new Error("network");
        }),
      }),
      executeZendeskTool: vi.fn(),
    });

    await controller.send("Check", context);

    expect(controller.getSnapshot()).toMatchObject({
      status: "error",
      messages: [{ role: "user", content: "Check" }],
    });
  });

  it("keeps conversation continuity after a partial first-turn error", async () => {
    const controller = new ChatController({
      worker: worker({
        startTurn: vi.fn(async (): Promise<TurnResponse> => ({
          kind: "error",
          code: "orchestration_limit",
          message: "Limit reached",
          retryable: true,
          partial: {
            conversationId: "conv_partial",
            messageId: "msg_partial",
            content: "One lookup completed.",
            citations: [],
            toolEvents: [],
          },
        })),
      }),
      executeZendeskTool: vi.fn(),
    });

    await controller.send("Check", context);

    expect(controller.getSnapshot()).toMatchObject({
      activeConversationId: "conv_partial",
      status: "error",
      messages: [{ role: "user" }, { id: "msg_partial", role: "assistant" }],
    });
  });

  it("loads the newest retained conversation", async () => {
    const listConversations = vi.fn(async () => ({
      conversations: [
        {
          id: "conv_new",
          tenantKey: "tenant",
          ticketId: 8421,
          createdAt: "2026-07-18T12:00:00.000Z",
          updatedAt: "2026-07-18T13:00:00.000Z",
          expiresAt: "2026-10-16T13:00:00.000Z",
        },
      ],
    }));
    const getConversation = vi.fn(async () => ({
      conversation: {
        id: "conv_new",
        tenantKey: "tenant",
        ticketId: 8421,
        createdAt: "2026-07-18T12:00:00.000Z",
        updatedAt: "2026-07-18T13:00:00.000Z",
        expiresAt: "2026-10-16T13:00:00.000Z",
      },
      messages: [
        {
          id: "msg_1",
          conversationId: "conv_new",
          role: "assistant" as const,
          content: "Saved answer",
          createdAt: "2026-07-18T13:00:00.000Z",
          citations: [
            {
              provider: "zendesk" as const,
              label: "Ticket 7314",
              providerId: "7314",
              url: "https://example.zendesk.com/agent/tickets/7314",
            },
          ],
          toolEvents: [
            {
              skillId: "zendesk",
              toolName: "zendesk_get_ticket",
              status: "succeeded" as const,
              summary: "Zendesk lookup completed.",
            },
          ],
        },
      ],
      toolRuns: [],
    }));
    const controller = new ChatController({
      worker: worker({ listConversations, getConversation }),
      executeZendeskTool: vi.fn(),
    });

    await controller.loadHistory(8421);

    expect(getConversation).toHaveBeenCalledWith("conv_new");
    expect(controller.getSnapshot()).toMatchObject({
      activeConversationId: "conv_new",
      messages: [
        {
          content: "Saved answer",
          citations: [{ providerId: "7314" }],
          toolEvents: [{ toolName: "zendesk_get_ticket" }],
        },
      ],
    });
  });

  it("starts a fresh local conversation without deleting history", () => {
    const controller = new ChatController({
      worker: worker(),
      executeZendeskTool: vi.fn(),
    });

    controller.newConversation();

    expect(controller.getSnapshot()).toMatchObject({
      activeConversationId: undefined,
      messages: [],
      status: "ready",
    });
  });
});
