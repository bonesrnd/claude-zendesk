import { CitationSchema } from "@resolve/contracts";
import { defineSkill, defineTool, SkillRegistry } from "@resolve/skill-sdk";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import type {
  ModelClient,
  ModelMessage,
  ModelResponse,
} from "../model/model-client";
import { resumeTurn, runTurn, type PendingTurnState } from "./run-turn";

const ticket = {
  ticketId: 8421,
  subject: "Where is my order?",
  requester: { id: 77, name: "Maya Chen", email: "maya@example.com" },
  brand: { id: 123, name: "Solution Peptides" },
  recentConversation: [],
};

const ToolInput = z.strictObject({ id: z.string() });
const ToolOutput = z.strictObject({
  value: z.string(),
  citations: z.array(CitationSchema),
});

function registry(options: {
  onServerCall?: (id: string) => void;
  delegated?: boolean;
}) {
  const tool = defineTool({
    name: options.delegated ? "zendesk_read" : "server_read",
    description: "Read a record",
    risk: "read",
    requiresConfirmation: false,
    execution: options.delegated ? "delegated" : "server",
    inputSchema: ToolInput,
    outputSchema: ToolOutput,
    ...(options.delegated
      ? {}
      : {
          async handler(input: z.infer<typeof ToolInput>) {
            options.onServerCall?.(input.id);
            return {
              value: input.id,
              citations: [
                {
                  provider: "woocommerce" as const,
                  label: `Order ${input.id}`,
                  providerId: input.id,
                  url: `https://store.example/orders/${input.id}`,
                },
              ],
            };
          },
        }),
  });
  return new SkillRegistry([
    defineSkill({
      id: options.delegated ? "zendesk" : "server",
      name: "Test",
      version: "1.0.0",
      instructions: "Use the test tool.",
      credentials: [],
      tools: [tool],
    }),
  ]);
}

class ScriptedModel implements ModelClient {
  readonly calls: Array<{
    system: string;
    messages: ModelMessage[];
  }> = [];

  constructor(private readonly responses: Array<ModelResponse | Error>) {}

  async createMessage(
    input: Parameters<ModelClient["createMessage"]>[0],
  ): Promise<ModelResponse> {
    this.calls.push({
      system: input.system,
      messages: structuredClone(input.messages),
    });
    const response = this.responses.shift();
    if (!response) throw new Error("No scripted response");
    if (response instanceof Error) throw response;
    return response;
  }
}

const context = {
  signal: new AbortController().signal,
  credentials: {},
  tenantKey: "tenant",
  ticketId: 8421,
};

describe("runTurn", () => {
  it("returns a direct assistant answer", async () => {
    const model = new ScriptedModel([
      {
        stopReason: "end_turn",
        blocks: [{ type: "text", text: "The order shipped." }],
      },
    ]);

    const result = await runTurn({
      model,
      registry: registry({}),
      conversationId: "conv_1",
      ticket,
      messages: [{ role: "user", content: "Check the order" }],
      toolContext: context,
      pendingTurns: {
        async save() {
          throw new Error("not expected");
        },
      },
    });

    expect(result).toMatchObject({
      kind: "completed",
      text: "The order shipped.",
      citations: [],
    });
  });

  it("bounds retained model history before calling Claude", async () => {
    const model = new ScriptedModel([
      {
        stopReason: "end_turn",
        blocks: [{ type: "text", text: "Bounded." }],
      },
    ]);
    const messages = Array.from({ length: 100 }, (_, index): ModelMessage => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `${index}:${"x".repeat(1_990)}`,
    }));

    await runTurn({
      model,
      registry: registry({}),
      conversationId: "conv_1",
      ticket,
      messages,
      toolContext: context,
      pendingTurns: {
        async save() {
          throw new Error("not expected");
        },
      },
    });

    const sent = model.calls[0]?.messages ?? [];
    expect(sent.length).toBeLessThanOrEqual(40);
    expect(JSON.stringify(sent).length).toBeLessThanOrEqual(80_000);
    expect(JSON.stringify(sent)).toContain("99:");
  });

  it("executes a server read and returns its citations", async () => {
    const executed: string[] = [];
    const model = new ScriptedModel([
      {
        stopReason: "tool_use",
        blocks: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "server_read",
            input: { id: "10982" },
          },
        ],
      },
      {
        stopReason: "end_turn",
        blocks: [{ type: "text", text: "Order 10982 is processing." }],
      },
    ]);

    const result = await runTurn({
      model,
      registry: registry({
        onServerCall(id) {
          executed.push(id);
        },
      }),
      conversationId: "conv_1",
      ticket,
      messages: [{ role: "user", content: "Check 10982" }],
      toolContext: context,
      pendingTurns: {
        async save() {
          throw new Error("not expected");
        },
      },
    });

    expect(executed).toEqual(["10982"]);
    expect(result).toMatchObject({
      kind: "completed",
      citations: [{ providerId: "10982" }],
      toolEvents: [{ toolName: "server_read", status: "succeeded" }],
    });
    expect(model.calls[1]?.messages.at(-1)).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", toolUseId: "tool_1", isError: false }],
    });
  });

  it("persists delegated state and returns typed requests", async () => {
    let saved: PendingTurnState | undefined;
    const model = new ScriptedModel([
      {
        stopReason: "tool_use",
        blocks: [
          {
            type: "tool_use",
            id: "tool_2",
            name: "zendesk_read",
            input: { id: "7314" },
          },
        ],
      },
    ]);

    const result = await runTurn({
      model,
      registry: registry({ delegated: true }),
      conversationId: "conv_1",
      ticket,
      messages: [{ role: "user", content: "Check prior tickets" }],
      toolContext: context,
      pendingTurns: {
        async save(_conversationId, state) {
          saved = state;
          return { id: "turn_1" };
        },
      },
    });

    expect(result).toEqual({
      kind: "delegated",
      turnId: "turn_1",
      requests: [
        {
          toolUseId: "tool_2",
          toolName: "zendesk_read",
          input: { id: "7314" },
        },
      ],
    });
    expect(saved?.outstandingToolUseIds).toEqual(["tool_2"]);
    expect(saved?.remainingModelCalls).toBe(5);
    expect(saved?.deadlineAt).toBeGreaterThan(Date.now());
  });

  it("resumes delegated state with matching results", async () => {
    const model = new ScriptedModel([
      {
        stopReason: "end_turn",
        blocks: [{ type: "text", text: "Ticket 7314 used a replacement." }],
      },
    ]);
    const state: PendingTurnState = {
      ticket,
      messages: [
        { role: "user", content: "Check prior tickets" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_2",
              name: "zendesk_read",
              input: { id: "7314" },
            },
          ],
        },
      ],
      completedResults: [],
      citations: [],
      toolEvents: [],
      outstandingToolUseIds: ["tool_2"],
      remainingModelCalls: 5,
      deadlineAt: Date.now() + 30_000,
    };

    const result = await resumeTurn({
      model,
      registry: registry({ delegated: true }),
      conversationId: "conv_1",
      state,
      delegatedResults: [
        {
          toolUseId: "tool_2",
          toolName: "zendesk_read",
          output: {
            value: "replacement",
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
      toolContext: context,
      pendingTurns: {
        async save() {
          throw new Error("not expected");
        },
      },
    });

    expect(result).toMatchObject({
      kind: "completed",
      citations: [{ provider: "zendesk", providerId: "7314" }],
    });
  });

  it("returns unknown tools to the model as errors", async () => {
    const model = new ScriptedModel([
      {
        stopReason: "tool_use",
        blocks: [
          { type: "tool_use", id: "tool_bad", name: "unknown_tool", input: {} },
        ],
      },
      {
        stopReason: "end_turn",
        blocks: [{ type: "text", text: "That source is unavailable." }],
      },
    ]);

    await runTurn({
      model,
      registry: registry({}),
      conversationId: "conv_1",
      ticket,
      messages: [{ role: "user", content: "Use an unknown tool" }],
      toolContext: context,
      pendingTurns: {
        async save() {
          throw new Error("not expected");
        },
      },
    });

    expect(model.calls[1]?.messages.at(-1)).toMatchObject({
      content: [
        {
          type: "tool_result",
          toolUseId: "tool_bad",
          isError: true,
        },
      ],
    });
  });

  it("reports token exhaustion as a visible limit", async () => {
    const model = new ScriptedModel([
      {
        stopReason: "max_tokens",
        blocks: [{ type: "text", text: "A truncated answer" }],
      },
    ]);

    const result = await runTurn({
      model,
      registry: registry({}),
      conversationId: "conv_1",
      ticket,
      messages: [{ role: "user", content: "Write a long answer" }],
      toolContext: context,
      pendingTurns: {
        async save() {
          throw new Error("not expected");
        },
      },
    });

    expect(result).toMatchObject({
      kind: "error",
      code: "orchestration_limit",
      message: "Claude reached its output limit before finishing.",
      partial: { content: "A truncated answer" },
    });
  });

  it("preserves partial research when an in-flight model call times out", async () => {
    const model = new ScriptedModel([
      {
        stopReason: "tool_use",
        blocks: [
          {
            type: "tool_use",
            id: "tool_timeout",
            name: "server_read",
            input: { id: "10982" },
          },
        ],
      },
      new DOMException("Timed out", "TimeoutError"),
    ]);

    const result = await runTurn({
      model,
      registry: registry({}),
      conversationId: "conv_1",
      ticket,
      messages: [{ role: "user", content: "Check then timeout" }],
      toolContext: context,
      pendingTurns: {
        async save() {
          throw new Error("not expected");
        },
      },
    });

    expect(result).toMatchObject({
      kind: "error",
      code: "orchestration_limit",
      partial: {
        citations: [{ providerId: "10982" }],
        toolEvents: [{ toolName: "server_read" }],
      },
    });
  });

  it("stops a repeating tool loop", async () => {
    const toolResponse: ModelResponse = {
      stopReason: "tool_use",
      blocks: [
        {
          type: "tool_use",
          id: "tool_loop",
          name: "server_read",
          input: { id: "1" },
        },
      ],
    };
    const model = new ScriptedModel(
      Array.from({ length: 6 }, () => toolResponse),
    );

    const result = await runTurn({
      model,
      registry: registry({}),
      conversationId: "conv_1",
      ticket,
      messages: [{ role: "user", content: "Loop" }],
      toolContext: context,
      pendingTurns: {
        async save() {
          throw new Error("not expected");
        },
      },
    });

    expect(result).toMatchObject({
      kind: "error",
      code: "orchestration_limit",
      message: "Resolve reached the tool-call limit for this message.",
      retryable: true,
      partial: {
        citations: [{ providerId: "1" }],
      },
    });
    if (result.kind !== "error") throw new Error("Expected limit error");
    expect(result.partial?.toolEvents).toHaveLength(6);
    expect(
      result.partial?.toolEvents.every(
        (event) =>
          event.toolName === "server_read" && event.status === "succeeded",
      ),
    ).toBe(true);
  });
});
