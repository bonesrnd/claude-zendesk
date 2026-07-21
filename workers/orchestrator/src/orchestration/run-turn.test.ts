import { CitationSchema } from "@resolve/contracts";
import { defineSkill, defineTool, SkillRegistry } from "@resolve/skill-sdk";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

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
const HandleInput = z.strictObject({ handle: z.string() });

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

function artifactRegistry() {
  const delegated = defineTool({
    name: "artifact_list",
    description: "List records",
    risk: "read",
    requiresConfirmation: false,
    execution: "delegated",
    inputSchema: ToolInput,
    outputSchema: ToolOutput,
  });
  const server = defineTool({
    name: "artifact_use",
    description: "Use one retained record",
    risk: "read",
    requiresConfirmation: false,
    execution: "server",
    inputSchema: HandleInput,
    outputSchema: ToolOutput,
    async handler() {
      throw new Error("runtime handler required");
    },
  });
  return new SkillRegistry([
    defineSkill({
      id: "artifact_test",
      name: "Artifacts",
      version: "1.0.0",
      instructions: "Use retained test artifacts.",
      credentials: [],
      tools: [delegated, server],
    }),
  ]);
}

function writeRegistry(onServerCall: () => void) {
  return new SkillRegistry([
    defineSkill({
      id: "write_test",
      name: "Write test",
      version: "1.0.0",
      instructions: "Propose a write.",
      credentials: [],
      tools: [
        defineTool({
          name: "zendesk_update_customer_profile",
          description: "Propose a profile update",
          risk: "write",
          requiresConfirmation: true,
          execution: "server",
          inputSchema: z.strictObject({
            userId: z.number().int().positive(),
            recordVersion: z.string(),
            before: z.record(z.string(), z.unknown()),
            changes: z.record(z.string(), z.unknown()),
          }),
          outputSchema: z.strictObject({ verified: z.literal(true) }),
          createProposal(input) {
            return {
              action: "zendesk_update_customer_profile",
              targetId: input.userId,
              before: input.before,
              changes: input.changes,
              recordVersion: input.recordVersion,
            };
          },
          async handler() {
            onServerCall();
            return { verified: true as const };
          },
        }),
      ],
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
  it("persists a proposal without executing a write handler", async () => {
    const onServerCall = vi.fn();
    const capability = `confirm_${"a".repeat(64)}`;
    const saveProposal = vi.fn(async () => ({
      capability,
      proposal: {
        id: "turn_write",
        conversationId: "conv_1",
        agentId: 9,
        action: "zendesk_update_customer_profile" as const,
        targetId: 77,
        before: { phone: "+15551230000" },
        changes: { phone: "+15559870000" },
        recordVersion: "version-1",
        expiresAt: "2026-07-21T12:10:00.000Z",
        status: "pending" as const,
      },
    }));
    let savedState: PendingTurnState | undefined;
    const model = new ScriptedModel([
      {
        stopReason: "tool_use",
        blocks: [
          {
            type: "tool_use",
            id: "tool_write",
            name: "zendesk_update_customer_profile",
            input: {
              userId: 77,
              recordVersion: "version-1",
              before: { phone: "+15551230000" },
              changes: { phone: "+15559870000" },
            },
          },
        ],
      },
    ]);

    const result = await runTurn({
      model,
      registry: writeRegistry(onServerCall),
      conversationId: "conv_1",
      agentId: 9,
      ticket,
      messages: [{ role: "user", content: "Update the phone" }],
      toolContext: context,
      pendingTurns: {
        async save(_conversationId, state) {
          savedState = state;
          return { id: "turn_write" };
        },
      },
      writeProposals: { save: saveProposal },
    });

    expect(onServerCall).not.toHaveBeenCalled();
    expect(saveProposal).toHaveBeenCalledWith(
      "turn_write",
      "conv_1",
      9,
      expect.objectContaining({
        action: "zendesk_update_customer_profile",
        recordVersion: "version-1",
      }),
    );
    expect(result).toEqual({
      kind: "confirmation_required",
      capability,
      proposal: {
        id: "turn_write",
        action: "zendesk_update_customer_profile",
        targetId: 77,
        before: { phone: "+15551230000" },
        changes: { phone: "+15559870000" },
        expiresAt: "2026-07-21T12:10:00.000Z",
      },
    });
    expect(JSON.stringify(savedState)).not.toContain(capability);
    expect(JSON.stringify(model.calls)).not.toContain(capability);
  });

  it("rejects a write proposal for a target outside the active ticket", async () => {
    const onServerCall = vi.fn();
    const saveProposal = vi.fn();
    const model = new ScriptedModel([
      {
        stopReason: "tool_use",
        blocks: [
          {
            type: "tool_use",
            id: "tool_wrong_target",
            name: "zendesk_update_customer_profile",
            input: {
              userId: 999,
              recordVersion: "version-1",
              before: { phone: "+15551230000" },
              changes: { phone: "+15559870000" },
            },
          },
        ],
      },
    ]);

    const result = await runTurn({
      model,
      registry: writeRegistry(onServerCall),
      conversationId: "conv_1",
      agentId: 9,
      ticket,
      messages: [{ role: "user", content: "Update another customer" }],
      toolContext: context,
      pendingTurns: {
        async save() {
          throw new Error("not expected");
        },
      },
      writeProposals: { save: saveProposal },
    });

    expect(result).toMatchObject({
      kind: "error",
      code: "validation_error",
    });
    expect(onServerCall).not.toHaveBeenCalled();
    expect(saveProposal).not.toHaveBeenCalled();
  });

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

  it("uses request-scoped runtime handlers for registered server tools", async () => {
    const defaultCalls: string[] = [];
    const runtimeCalls: string[] = [];
    const model = new ScriptedModel([
      {
        stopReason: "tool_use",
        blocks: [
          {
            type: "tool_use",
            id: "tool_runtime",
            name: "server_read",
            input: { id: "10982" },
          },
        ],
      },
      {
        stopReason: "end_turn",
        blocks: [{ type: "text", text: "Runtime result used." }],
      },
    ]);

    const result = await runTurn({
      model,
      registry: registry({
        onServerCall(id) {
          defaultCalls.push(id);
        },
      }),
      conversationId: "conv_1",
      ticket,
      messages: [{ role: "user", content: "Use the runtime tool" }],
      toolContext: context,
      serverToolHandlers: {
        async server_read(input) {
          const parsed = ToolInput.parse(input);
          runtimeCalls.push(parsed.id);
          return {
            value: `runtime:${parsed.id}`,
            citations: [],
          };
        },
      },
      pendingTurns: {
        async save() {
          throw new Error("not expected");
        },
      },
    });

    expect(result).toMatchObject({ kind: "completed" });
    expect(runtimeCalls).toEqual(["10982"]);
    expect(defaultCalls).toEqual([]);
    expect(model.calls[1]?.messages.at(-1)).toMatchObject({
      content: [
        {
          content: { value: "runtime:10982" },
          isError: false,
        },
      ],
    });
  });

  it("never sends partial serialized JSON for oversized tool results", async () => {
    const model = new ScriptedModel([
      {
        stopReason: "tool_use",
        blocks: [
          {
            type: "tool_use",
            id: "tool_large",
            name: "server_read",
            input: { id: "large" },
          },
        ],
      },
      {
        stopReason: "end_turn",
        blocks: [{ type: "text", text: "Large result omitted safely." }],
      },
    ]);

    await runTurn({
      model,
      registry: registry({}),
      conversationId: "conv_1",
      ticket,
      messages: [{ role: "user", content: "Read a large result" }],
      toolContext: context,
      serverToolHandlers: {
        async server_read() {
          return { value: `SECRET_${"x".repeat(7_000)}`, citations: [] };
        },
      },
      pendingTurns: {
        async save() {
          throw new Error("not expected");
        },
      },
    });

    expect(model.calls[1]?.messages.at(-1)).toMatchObject({
      content: [
        {
          content: {
            truncated: true,
            originalCharacters: expect.any(Number),
          },
          isError: false,
        },
      ],
    });
    expect(model.calls[1]?.messages.at(-1)).not.toMatchObject({
      content: [{ content: { content: expect.any(String) } }],
    });
    expect(JSON.stringify(model.calls[1]?.messages)).not.toContain("SECRET_");
  });

  it("persists artifacts retained by a server tool through delegation", async () => {
    const handle = "transcript_opaque";
    let saved: PendingTurnState | undefined;
    const firstModel = new ScriptedModel([
      {
        stopReason: "tool_use",
        blocks: [
          {
            type: "tool_use",
            id: "tool_store",
            name: "artifact_use",
            input: { handle },
          },
          {
            type: "tool_use",
            id: "tool_pause",
            name: "artifact_list",
            input: { id: "pause" },
          },
        ],
      },
    ]);

    await runTurn({
      model: firstModel,
      registry: artifactRegistry(),
      conversationId: "conv_1",
      ticket,
      messages: [{ role: "user", content: "Store then pause" }],
      toolContext: context,
      serverToolHandlers: {
        async artifact_use(input, runtimeContext) {
          const { handle: requested } = HandleInput.parse(input);
          runtimeContext.retainArtifact(requested, {
            value: "complete-transcript",
          });
          return { value: "stored", citations: [] };
        },
      },
      pendingTurns: {
        async save(_conversationId, state) {
          saved = state;
          return { id: "turn_artifact" };
        },
      },
    });

    expect(saved?.retainedArtifacts).toEqual({
      [handle]: { value: "complete-transcript" },
    });
    if (!saved) throw new Error("Expected retained pending state");

    const secondModel = new ScriptedModel([
      {
        stopReason: "tool_use",
        blocks: [
          {
            type: "tool_use",
            id: "tool_read",
            name: "artifact_use",
            input: { handle },
          },
        ],
      },
      {
        stopReason: "end_turn",
        blocks: [{ type: "text", text: "Complete transcript read." }],
      },
    ]);
    await resumeTurn({
      model: secondModel,
      registry: artifactRegistry(),
      conversationId: "conv_1",
      state: saved,
      delegatedResults: [
        {
          toolUseId: "tool_pause",
          toolName: "artifact_list",
          output: { value: "resumed", citations: [] },
          isError: false,
        },
      ],
      toolContext: context,
      serverToolHandlers: {
        async artifact_use(input, runtimeContext) {
          const { handle: requested } = HandleInput.parse(input);
          const retained = runtimeContext.retainedArtifacts[requested];
          return {
            value: z.object({ value: z.string() }).parse(retained).value,
            citations: [],
          };
        },
      },
      pendingTurns: {
        async save() {
          throw new Error("not expected");
        },
      },
    });

    expect(secondModel.calls[1]?.messages.at(-1)).toMatchObject({
      content: [
        {
          content: { value: "complete-transcript" },
          isError: false,
        },
      ],
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

  it("retains delegated artifacts across another pause and resume", async () => {
    const handle = "artifact_opaque";
    const firstModel = new ScriptedModel([
      {
        stopReason: "tool_use",
        blocks: [
          {
            type: "tool_use",
            id: "tool_second_list",
            name: "artifact_list",
            input: { id: "second" },
          },
        ],
      },
    ]);
    const initialState: PendingTurnState = {
      ticket,
      messages: [
        { role: "user", content: "Find a record" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_first_list",
              name: "artifact_list",
              input: { id: "first" },
            },
          ],
        },
      ],
      completedResults: [],
      citations: [],
      toolEvents: [],
      outstandingToolUseIds: ["tool_first_list"],
      remainingModelCalls: 5,
      deadlineAt: Date.now() + 30_000,
    };
    let saved: PendingTurnState | undefined;

    const firstResult = await resumeTurn({
      model: firstModel,
      registry: artifactRegistry(),
      conversationId: "conv_1",
      state: initialState,
      delegatedResults: [
        {
          toolUseId: "tool_first_list",
          toolName: "artifact_list",
          output: { value: "full-secret-record", citations: [] },
          isError: false,
        },
      ],
      delegatedResultAdapters: {
        artifact_list() {
          return {
            modelOutput: { handles: [handle] },
            retainedArtifacts: {
              [handle]: { value: "full-secret-record" },
            },
          };
        },
      },
      toolContext: context,
      pendingTurns: {
        async save(_conversationId, state) {
          saved = state;
          return { id: "turn_2" };
        },
      },
    });

    expect(firstResult).toMatchObject({ kind: "delegated", turnId: "turn_2" });
    expect(JSON.stringify(firstModel.calls[0]?.messages)).not.toContain(
      "full-secret-record",
    );
    expect(firstModel.calls[0]?.messages.at(-1)).toMatchObject({
      content: [
        {
          content: { handles: [handle] },
          isError: false,
        },
      ],
    });
    expect(saved?.retainedArtifacts).toEqual({
      [handle]: { value: "full-secret-record" },
    });
    if (!saved) throw new Error("Expected retained pending state");

    const secondModel = new ScriptedModel([
      {
        stopReason: "tool_use",
        blocks: [
          {
            type: "tool_use",
            id: "tool_use_artifact",
            name: "artifact_use",
            input: { handle },
          },
        ],
      },
      {
        stopReason: "end_turn",
        blocks: [{ type: "text", text: "Retained record used." }],
      },
    ]);

    await resumeTurn({
      model: secondModel,
      registry: artifactRegistry(),
      conversationId: "conv_1",
      state: saved,
      delegatedResults: [
        {
          toolUseId: "tool_second_list",
          toolName: "artifact_list",
          output: { value: "second-record", citations: [] },
          isError: false,
        },
      ],
      delegatedResultAdapters: {
        artifact_list() {
          return { modelOutput: { handles: [] }, retainedArtifacts: {} };
        },
      },
      serverToolHandlers: {
        async artifact_use(input, runtimeContext) {
          const { handle: requested } = HandleInput.parse(input);
          const retained = runtimeContext.retainedArtifacts[requested];
          return {
            value: z.object({ value: z.string() }).parse(retained).value,
            citations: [],
          };
        },
      },
      toolContext: context,
      pendingTurns: {
        async save() {
          throw new Error("not expected");
        },
      },
    });

    expect(secondModel.calls[1]?.messages.at(-1)).toMatchObject({
      content: [
        {
          content: { value: "full-secret-record" },
          isError: false,
        },
      ],
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
      message: "Słones reached the tool-call limit for this message.",
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
