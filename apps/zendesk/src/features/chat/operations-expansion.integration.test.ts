import type { TurnResponse } from "@resolve/contracts";
import { describe, expect, it, vi } from "vitest";

import type { ZafClient } from "../../types/zaf";
import {
  executeConfirmedZendeskAction,
  inspectZendeskProposal,
} from "../zendesk-tools/executor";
import type { ActiveTicketContext } from "../ticket/ticket-context";
import { ChatController, type ChatWorker } from "./chat-controller";

const context: ActiveTicketContext = {
  ticket: {
    ticketId: 8421,
    subject: "Callback requested",
    requester: { id: 77, name: "Maya Chen", email: "maya@example.com" },
    brand: { id: 123, name: "Solution Peptides" },
    recentConversation: [],
  },
  agent: { id: 9, name: "Agent" },
};

const proposalResponse: TurnResponse = {
  kind: "action_confirmation_required",
  conversationId: "conv_write",
  capability: `confirm_${"a".repeat(64)}`,
  proposal: {
    id: "turn_write",
    action: "zendesk_update_customer_profile",
    targetId: 77,
    before: { phone: "+15551230000" },
    changes: { phone: "+15559870000" },
    expiresAt: "2026-07-21T12:10:00.000Z",
  },
};

function assistant(content: string): TurnResponse {
  return {
    kind: "assistant_message",
    conversationId: "conv_write",
    messageId: "msg_verified",
    content,
    citations: [],
    toolEvents: [],
  };
}

function worker(overrides: Partial<ChatWorker>): ChatWorker {
  return {
    startTurn: vi.fn(async () => proposalResponse),
    continueTurn: vi.fn(async () => assistant("Update verified.")),
    confirmAction: vi.fn(),
    listConversations: vi.fn(async () => ({ conversations: [] })),
    getConversation: vi.fn(),
    ...overrides,
  };
}

function createZendeskHarness() {
  let currentUser = {
    id: 77,
    updated_at: "version-1",
    name: "Maya Chen",
    phone: "+15551230000",
    notes: "",
    organization_id: 42,
    user_fields: {},
  };
  let wrote = false;
  let refetchedAfterWrite = false;
  const request = vi.fn(
    async (options: {
      url: string;
      type: string;
      data?: string;
    }): Promise<unknown> => {
      if (options.type === "GET" && options.url === "/api/v2/users/77.json") {
        if (wrote) refetchedAfterWrite = true;
        return { user: structuredClone(currentUser) };
      }
      if (options.type === "PUT" && options.url === "/api/v2/users/77.json") {
        const body = JSON.parse(options.data ?? "{}") as {
          user?: Record<string, unknown>;
        };
        currentUser = {
          ...currentUser,
          ...body.user,
          updated_at: "version-2",
        };
        wrote = true;
        return { user: structuredClone(currentUser) };
      }
      throw new Error(`Unexpected ZAF request: ${options.type} ${options.url}`);
    },
  );
  return {
    client: { request } as unknown as ZafClient,
    request,
    changeCurrentPhone(phone: string) {
      currentUser = {
        ...currentUser,
        phone,
        updated_at: "version-external",
      };
    },
    get wrote() {
      return wrote;
    },
    get refetchedAfterWrite() {
      return refetchedAfterWrite;
    },
  };
}

describe("operations expansion write integration", () => {
  it("requires dedicated confirmation, writes once, refetches, and continues", async () => {
    const zendesk = createZendeskHarness();
    const confirmAction = vi.fn(async () => ({
      kind: "delegated_tool_request" as const,
      turnId: "turn_write",
      requests: [
        {
          toolUseId: "tool_write",
          toolName: "zendesk_update_customer_profile" as const,
          input: {
            userId: 77,
            recordVersion: "version-1",
            before: { phone: "+15551230000" },
            changes: { phone: "+15559870000" },
          },
        },
      ],
    }));
    const continueTurn = vi.fn(async (input) => {
      expect(input).toMatchObject({
        turnId: "turn_write",
        results: [
          {
            toolUseId: "tool_write",
            isError: false,
            output: {
              recordVersion: "version-2",
              after: { phone: "+15559870000" },
              verified: true,
            },
          },
        ],
      });
      return assistant("Phone update verified after refetch.");
    });
    const controller = new ChatController({
      worker: worker({ confirmAction, continueTurn }),
      executeZendeskTool: vi.fn(),
      inspectZendeskProposal: (proposal) =>
        inspectZendeskProposal(zendesk.client, proposal),
      executeConfirmedZendeskAction: (request) =>
        executeConfirmedZendeskAction(zendesk.client, request, "example"),
      now: () => new Date("2026-07-21T12:00:00.000Z"),
    });

    await controller.send("Update the customer phone", context);

    expect(zendesk.wrote).toBe(false);
    expect(confirmAction).not.toHaveBeenCalled();

    await controller.confirmAction();

    expect(confirmAction).toHaveBeenCalledWith("turn_write", {
      capability: `confirm_${"a".repeat(64)}`,
      recordVersion: "version-1",
    });
    expect(
      zendesk.request.mock.calls.filter(([options]) => options.type === "PUT"),
    ).toHaveLength(1);
    expect(zendesk.refetchedAfterWrite).toBe(true);
    expect(continueTurn).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({
      status: "ready",
      proposal: undefined,
      messages: [
        { role: "user" },
        {
          role: "assistant",
          content: "Phone update verified after refetch.",
        },
      ],
    });
  });

  it("rejects a proposal that becomes stale before confirmation", async () => {
    const zendesk = createZendeskHarness();
    const confirmAction = vi.fn();
    const controller = new ChatController({
      worker: worker({ confirmAction }),
      executeZendeskTool: vi.fn(),
      inspectZendeskProposal: (proposal) =>
        inspectZendeskProposal(zendesk.client, proposal),
      executeConfirmedZendeskAction: (request) =>
        executeConfirmedZendeskAction(zendesk.client, request, "example"),
      now: () => new Date("2026-07-21T12:00:00.000Z"),
    });
    await controller.send("Update the customer phone", context);
    zendesk.changeCurrentPhone("+15550000000");

    await controller.confirmAction();

    expect(confirmAction).not.toHaveBeenCalled();
    expect(zendesk.wrote).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({
      status: "error",
      error: { code: "write_confirmation_failed", retryable: false },
    });
  });

  it("rejects a proposal that expires before the confirm click", async () => {
    const zendesk = createZendeskHarness();
    const confirmAction = vi.fn();
    let now = new Date("2026-07-21T12:00:00.000Z");
    const controller = new ChatController({
      worker: worker({ confirmAction }),
      executeZendeskTool: vi.fn(),
      inspectZendeskProposal: (proposal) =>
        inspectZendeskProposal(zendesk.client, proposal),
      executeConfirmedZendeskAction: (request) =>
        executeConfirmedZendeskAction(zendesk.client, request, "example"),
      now: () => now,
    });
    await controller.send("Update the customer phone", context);
    now = new Date("2026-07-21T12:11:00.000Z");

    await controller.confirmAction();

    expect(confirmAction).not.toHaveBeenCalled();
    expect(zendesk.wrote).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({
      status: "error",
      error: { code: "proposal_expired", retryable: false },
    });
  });
});
