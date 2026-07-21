import {
  CitationSchema,
  TicketContextSchema,
  ToolEventSchema,
  WriteProposalSchema,
  type Citation,
  type TicketContext,
  type ToolEvent,
  type WriteProposal,
  type WriteProposalDraft,
} from "@resolve/contracts";
import {
  type RegisteredToolEntry,
  SkillRegistry,
  type ToolExecutionContext,
} from "@resolve/skill-sdk";
import { z } from "zod";

import type {
  ModelBlock,
  ModelClient,
  ModelMessage,
  ModelTool,
} from "../model/model-client";
import { buildSystemPrompt } from "./prompt";

export const TURN_LIMITS = {
  maxModelCalls: 6,
  maxToolsPerResponse: 10,
  timeoutMs: 45_000,
  maxToolResultChars: 6_000,
} as const;

const MAX_MODEL_HISTORY_MESSAGES = 40;
const MAX_MODEL_HISTORY_CHARS = 80_000;

export interface PendingTurnState {
  agentId?: number | undefined;
  ticket: TicketContext;
  messages: ModelMessage[];
  completedResults: ModelBlock[];
  citations: Citation[];
  toolEvents: ToolEvent[];
  retainedArtifacts?: RetainedArtifacts | undefined;
  outstandingToolUseIds: string[];
  remainingModelCalls: number;
  deadlineAt: number;
}

const ModelBlockSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.strictObject({
    type: z.literal("tool_result"),
    toolUseId: z.string(),
    content: z.unknown(),
    isError: z.boolean(),
  }),
]);

const PendingTurnStateSchema = z.strictObject({
  agentId: z.number().int().positive().optional(),
  ticket: TicketContextSchema,
  messages: z.array(
    z.strictObject({
      role: z.enum(["user", "assistant"]),
      content: z.union([z.string(), z.array(ModelBlockSchema)]),
    }),
  ),
  completedResults: z.array(ModelBlockSchema),
  citations: z.array(CitationSchema),
  toolEvents: z.array(ToolEventSchema),
  retainedArtifacts: z.record(z.string().min(1), z.unknown()).optional(),
  outstandingToolUseIds: z.array(z.string()),
  remainingModelCalls: z.number().int().min(0).max(TURN_LIMITS.maxModelCalls),
  deadlineAt: z.number().int().positive(),
});

export function parsePendingTurnState(value: unknown): PendingTurnState {
  return PendingTurnStateSchema.parse(value);
}

interface PendingTurnStore {
  save(
    conversationId: string,
    state: PendingTurnState,
  ): Promise<{ id: string }>;
}

interface WriteProposalStore {
  save(
    id: string,
    conversationId: string,
    agentId: number,
    proposal: WriteProposalDraft,
  ): Promise<{ proposal: WriteProposal; capability: string }>;
}

export type ServerToolHandler = (
  input: unknown,
  context: RuntimeToolExecutionContext,
) => Promise<unknown>;

export type ServerToolHandlers = Readonly<Record<string, ServerToolHandler>>;
export type RetainedArtifacts = Record<string, unknown>;

export interface RuntimeToolExecutionContext extends ToolExecutionContext {
  retainedArtifacts: Readonly<RetainedArtifacts>;
  retainArtifact(handle: string, value: unknown): void;
}

export interface DelegatedResultAdaptation {
  modelOutput: unknown;
  retainedArtifacts: RetainedArtifacts;
}

export type DelegatedResultAdapter = (
  output: unknown,
) => DelegatedResultAdaptation;

export type DelegatedResultAdapters = Readonly<
  Record<string, DelegatedResultAdapter>
>;

interface RunTurnInput {
  model: ModelClient;
  registry: SkillRegistry;
  conversationId: string;
  agentId?: number;
  ticket: TicketContext;
  messages: ModelMessage[];
  toolContext: ToolExecutionContext;
  retainedArtifacts?: RetainedArtifacts;
  serverToolHandlers?: ServerToolHandlers;
  pendingTurns: PendingTurnStore;
  writeProposals?: WriteProposalStore;
}

interface ResumeTurnInput {
  model: ModelClient;
  registry: SkillRegistry;
  conversationId: string;
  agentId?: number;
  state: PendingTurnState;
  delegatedResults: Array<{
    toolUseId: string;
    toolName: string;
    output: unknown;
    isError: boolean;
  }>;
  toolContext: ToolExecutionContext;
  delegatedResultAdapters?: DelegatedResultAdapters;
  serverToolHandlers?: ServerToolHandlers;
  pendingTurns: PendingTurnStore;
  writeProposals?: WriteProposalStore;
}

export type RunTurnResult =
  | {
      kind: "completed";
      text: string;
      citations: Citation[];
      toolEvents: ToolEvent[];
      messages: ModelMessage[];
    }
  | {
      kind: "delegated";
      turnId: string;
      requests: Array<{
        toolUseId: string;
        toolName: string;
        input: unknown;
      }>;
    }
  | {
      kind: "confirmation_required";
      proposal: WriteProposal;
      capability: string;
    }
  | {
      kind: "error";
      code: "validation_error" | "orchestration_limit" | "integration_error";
      message: string;
      retryable: boolean;
      partial?: {
        content: string;
        citations: Citation[];
        toolEvents: ToolEvent[];
      };
    };

interface ToolCall {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

interface ToolOutcome {
  call: ToolCall;
  result?: ModelBlock;
  citations: Citation[];
  event?: ToolEvent;
  delegated?: {
    toolUseId: string;
    toolName: string;
    input: unknown;
  };
  proposal?: WriteProposalDraft;
}

function modelTools(registry: SkillRegistry): ModelTool[] {
  return registry.listTools().map(({ tool }) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema),
  }));
}

function collectCitations(output: unknown): Citation[] {
  if (!output || typeof output !== "object" || !("citations" in output)) {
    return [];
  }
  const result = z.array(CitationSchema).safeParse(output.citations);
  return result.success ? result.data : [];
}

function deduplicateCitations(citations: readonly Citation[]): Citation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = `${citation.provider}:${citation.providerId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function partialResult(
  content: string,
  citations: readonly Citation[],
  toolEvents: readonly ToolEvent[],
) {
  return {
    content,
    citations: deduplicateCitations(citations),
    toolEvents: [...toolEvents],
  };
}

function isTimeoutError(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}

function boundedResult(output: unknown): unknown {
  const serialized = JSON.stringify(output);
  if (serialized.length <= TURN_LIMITS.maxToolResultChars) return output;
  return {
    truncated: true,
    originalCharacters: serialized.length,
  };
}

function toolResult(
  toolUseId: string,
  content: unknown,
  isError: boolean,
): ModelBlock {
  return { type: "tool_result", toolUseId, content, isError };
}

function proposalTargetsActiveContext(
  proposal: WriteProposalDraft,
  ticket: TicketContext,
): boolean {
  return proposal.action === "zendesk_update_ticket_custom_fields"
    ? proposal.targetId === ticket.ticketId
    : proposal.targetId === ticket.requester.id;
}

async function executeTool(
  registered: RegisteredToolEntry | undefined,
  call: ToolCall,
  registry: SkillRegistry,
  context: RuntimeToolExecutionContext,
  serverToolHandlers?: ServerToolHandlers,
): Promise<ToolOutcome> {
  if (!registered) {
    return {
      call,
      result: toolResult(
        call.id,
        { error: "unknown_tool", toolName: call.name },
        true,
      ),
      citations: [],
      event: {
        skillId: "unknown",
        toolName: call.name,
        status: "failed",
        summary: "The requested tool is not registered.",
      },
    };
  }

  if (registered.tool.risk === "write") {
    const parsed = registered.tool.inputSchema.safeParse(call.input);
    if (!parsed.success || !registered.tool.createProposal) {
      return {
        call,
        result: toolResult(call.id, { error: "invalid_write_proposal" }, true),
        citations: [],
        event: {
          skillId: registered.skill.id,
          toolName: call.name,
          status: "failed",
          summary: "Słones rejected an invalid write proposal.",
        },
      };
    }
    return {
      call,
      citations: [],
      proposal: registered.tool.createProposal(parsed.data),
    };
  }

  if (registered.tool.execution === "delegated") {
    const parsed = registered.tool.inputSchema.safeParse(call.input);
    if (!parsed.success) {
      return {
        call,
        result: toolResult(call.id, { error: "invalid_tool_input" }, true),
        citations: [],
        event: {
          skillId: registered.skill.id,
          toolName: call.name,
          status: "failed",
          summary: "Słones rejected invalid tool input.",
        },
      };
    }
    return {
      call,
      citations: [],
      delegated: {
        toolUseId: call.id,
        toolName: call.name,
        input: parsed.data,
      },
    };
  }

  try {
    const runtimeHandler = serverToolHandlers?.[call.name];
    const output = runtimeHandler
      ? registered.tool.outputSchema.parse(
          await runtimeHandler(
            registered.tool.inputSchema.parse(call.input),
            context,
          ),
        )
      : await registry.executeServerTool(call.name, call.input, context);
    return {
      call,
      result: toolResult(call.id, boundedResult(output), false),
      citations: collectCitations(output),
      event: {
        skillId: registered.skill.id,
        toolName: call.name,
        status: "succeeded",
        summary: `${registered.skill.name} lookup completed.`,
      },
    };
  } catch {
    return {
      call,
      result: toolResult(call.id, { error: "tool_failed" }, true),
      citations: [],
      event: {
        skillId: registered.skill.id,
        toolName: call.name,
        status: "failed",
        summary: `${registered.skill.name} lookup failed.`,
      },
    };
  }
}

function orderResults(
  assistantBlocks: readonly ModelBlock[],
  results: readonly ModelBlock[],
): ModelBlock[] {
  const byId = new Map(
    results
      .filter(
        (block): block is Extract<ModelBlock, { type: "tool_result" }> =>
          block.type === "tool_result",
      )
      .map((block) => [block.toolUseId, block]),
  );
  return assistantBlocks.flatMap((block) => {
    if (block.type !== "tool_use") return [];
    const result = byId.get(block.id);
    return result ? [result] : [];
  });
}

function boundedModelMessages(
  messages: readonly ModelMessage[],
): ModelMessage[] {
  const selected: ModelMessage[] = [];
  let characters = 0;
  for (
    let index = messages.length - 1;
    index >= 0 && selected.length < MAX_MODEL_HISTORY_MESSAGES;
    index -= 1
  ) {
    const message = messages[index];
    if (!message) continue;
    const size = JSON.stringify(message).length;
    if (characters + size > MAX_MODEL_HISTORY_CHARS) break;
    selected.unshift(message);
    characters += size;
  }
  return selected;
}

async function runLoop(
  input: RunTurnInput,
  initialCitations: readonly Citation[] = [],
  initialEvents: readonly ToolEvent[] = [],
  budget: {
    remainingModelCalls: number;
    deadlineAt: number;
  } = {
    remainingModelCalls: TURN_LIMITS.maxModelCalls,
    deadlineAt: Date.now() + TURN_LIMITS.timeoutMs,
  },
): Promise<RunTurnResult> {
  const messages = boundedModelMessages(input.messages);
  const citations = [...initialCitations];
  const toolEvents = [...initialEvents];
  const retainedArtifacts = { ...(input.retainedArtifacts ?? {}) };
  const retainArtifact = (handle: string, value: unknown): void => {
    if (!handle || handle.length > 200) {
      throw new Error("Retained artifact handle is invalid");
    }
    if (Object.hasOwn(retainedArtifacts, handle)) {
      throw new Error("Retained artifact handle already exists");
    }
    retainedArtifacts[handle] = structuredClone(value);
  };
  const system = buildSystemPrompt(
    input.ticket,
    input.registry.skills.map((skill) => skill.instructions),
  );

  for (
    let modelCall = 0;
    modelCall < budget.remainingModelCalls;
    modelCall += 1
  ) {
    const remainingMs = budget.deadlineAt - Date.now();
    if (remainingMs <= 0) {
      return {
        kind: "error",
        code: "orchestration_limit",
        message: "Słones reached the time limit for this message.",
        retryable: true,
        partial: partialResult(
          "Słones completed partial research before reaching the time limit.",
          citations,
          toolEvents,
        ),
      };
    }
    const signal = AbortSignal.any([
      input.toolContext.signal,
      AbortSignal.timeout(remainingMs),
    ]);
    let response: Awaited<ReturnType<ModelClient["createMessage"]>>;
    try {
      response = await input.model.createMessage({
        system,
        messages,
        tools: modelTools(input.registry),
        signal,
      });
    } catch (error) {
      if (!isTimeoutError(error, signal)) throw error;
      return {
        kind: "error",
        code: "orchestration_limit",
        message: "Słones reached the time limit for this message.",
        retryable: true,
        partial: partialResult(
          "Słones completed partial research before reaching the time limit.",
          citations,
          toolEvents,
        ),
      };
    }
    const calls = response.blocks.filter(
      (block): block is ToolCall => block.type === "tool_use",
    );
    const responseText = response.blocks
      .filter(
        (block): block is Extract<ModelBlock, { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("");

    if (response.stopReason === "max_tokens") {
      return {
        kind: "error",
        code: "orchestration_limit",
        message: "Claude reached its output limit before finishing.",
        retryable: true,
        partial: partialResult(responseText, citations, toolEvents),
      };
    }
    if (
      response.stopReason === "pause_turn" ||
      response.stopReason === "refusal"
    ) {
      return {
        kind: "error",
        code: "integration_error",
        message:
          response.stopReason === "refusal"
            ? "Claude declined to complete this request."
            : "Claude paused before completing this request.",
        retryable: response.stopReason === "pause_turn",
        partial: partialResult(responseText, citations, toolEvents),
      };
    }

    if (calls.length === 0) {
      messages.push({ role: "assistant", content: response.blocks });
      return {
        kind: "completed",
        text: responseText,
        citations: deduplicateCitations(citations),
        toolEvents,
        messages,
      };
    }
    if (calls.length > TURN_LIMITS.maxToolsPerResponse) {
      return {
        kind: "error",
        code: "orchestration_limit",
        message: "Słones requested too many tools for one response.",
        retryable: true,
        partial: partialResult(
          "Słones stopped before running an oversized tool request.",
          citations,
          toolEvents,
        ),
      };
    }

    const assistantMessage: ModelMessage = {
      role: "assistant",
      content: response.blocks,
    };
    messages.push(assistantMessage);
    const outcomes = await Promise.all(
      calls.map((call) =>
        executeTool(
          input.registry.getTool(call.name),
          call,
          input.registry,
          {
            ...input.toolContext,
            signal,
            retainedArtifacts,
            retainArtifact,
          },
          input.serverToolHandlers,
        ),
      ),
    );
    for (const outcome of outcomes) {
      citations.push(...outcome.citations);
      if (outcome.event) toolEvents.push(outcome.event);
    }

    const completedResults = outcomes.flatMap((outcome) =>
      outcome.result ? [outcome.result] : [],
    );
    const delegated = outcomes.flatMap((outcome) =>
      outcome.delegated ? [outcome.delegated] : [],
    );
    const proposals = outcomes.filter(
      (outcome): outcome is ToolOutcome & { proposal: WriteProposalDraft } =>
        outcome.proposal !== undefined,
    );

    if (proposals.length > 0) {
      const proposed = proposals[0];
      if (
        proposals.length !== 1 ||
        !proposed ||
        delegated.length > 0 ||
        input.agentId === undefined ||
        !input.writeProposals
      ) {
        return {
          kind: "error",
          code: "validation_error",
          message: "Słones could not create a single owned write proposal.",
          retryable: false,
        };
      }
      if (!proposalTargetsActiveContext(proposed.proposal, input.ticket)) {
        return {
          kind: "error",
          code: "validation_error",
          message: "The write proposal target is outside the active ticket.",
          retryable: false,
        };
      }
      const saved = await input.pendingTurns.save(input.conversationId, {
        agentId: input.agentId,
        ticket: input.ticket,
        messages,
        completedResults,
        citations: deduplicateCitations(citations),
        toolEvents,
        retainedArtifacts,
        outstandingToolUseIds: [proposed.call.id],
        remainingModelCalls: budget.remainingModelCalls - modelCall - 1,
        deadlineAt: budget.deadlineAt,
      });
      const created = await input.writeProposals.save(
        saved.id,
        input.conversationId,
        input.agentId,
        proposed.proposal,
      );
      return {
        kind: "confirmation_required",
        capability: created.capability,
        proposal: WriteProposalSchema.parse({
          id: created.proposal.id,
          action: created.proposal.action,
          targetId: created.proposal.targetId,
          before: created.proposal.before,
          changes: created.proposal.changes,
          expiresAt: created.proposal.expiresAt,
        }),
      };
    }

    if (delegated.length > 0) {
      const saved = await input.pendingTurns.save(input.conversationId, {
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        ticket: input.ticket,
        messages,
        completedResults,
        citations: deduplicateCitations(citations),
        toolEvents,
        retainedArtifacts,
        outstandingToolUseIds: delegated.map((request) => request.toolUseId),
        remainingModelCalls: budget.remainingModelCalls - modelCall - 1,
        deadlineAt: budget.deadlineAt,
      });
      return {
        kind: "delegated",
        turnId: saved.id,
        requests: delegated,
      };
    }

    messages.push({
      role: "user",
      content: orderResults(response.blocks, completedResults),
    });
  }

  return {
    kind: "error",
    code: "orchestration_limit",
    message: "Słones reached the tool-call limit for this message.",
    retryable: true,
    partial: partialResult(
      "Słones completed partial research before reaching the tool-call limit.",
      citations,
      toolEvents,
    ),
  };
}

export async function runTurn(input: RunTurnInput): Promise<RunTurnResult> {
  return runLoop(input);
}

export async function resumeTurn(
  input: ResumeTurnInput,
): Promise<RunTurnResult> {
  const expected = new Set(input.state.outstandingToolUseIds);
  const received = new Set(
    input.delegatedResults.map((result) => result.toolUseId),
  );
  if (
    expected.size !== received.size ||
    [...expected].some((id) => !received.has(id))
  ) {
    return {
      kind: "error",
      code: "validation_error",
      message: "Delegated tool results did not match the pending turn.",
      retryable: false,
    };
  }

  const citations = [...input.state.citations];
  const events = [...input.state.toolEvents];
  const retainedArtifacts = { ...(input.state.retainedArtifacts ?? {}) };
  const delegatedBlocks = input.delegatedResults.map((result) => {
    const registered = input.registry.getTool(result.toolName);
    const output =
      result.isError || !registered
        ? result.output
        : registered.tool.outputSchema.parse(result.output);
    const adapted =
      !result.isError && registered
        ? input.delegatedResultAdapters?.[result.toolName]?.(output)
        : undefined;
    if (adapted) {
      Object.assign(retainedArtifacts, adapted.retainedArtifacts);
    }
    if (!result.isError) citations.push(...collectCitations(output));
    events.push({
      skillId: registered?.skill.id ?? "unknown",
      toolName: result.toolName,
      status: result.isError ? "failed" : "succeeded",
      summary: result.isError
        ? "Zendesk lookup failed."
        : "Zendesk lookup completed.",
    });
    return toolResult(
      result.toolUseId,
      boundedResult(adapted?.modelOutput ?? output),
      result.isError,
    );
  });

  const assistantBlocks = input.state.messages.at(-1)?.content;
  if (!Array.isArray(assistantBlocks)) {
    return {
      kind: "error",
      code: "validation_error",
      message: "Pending turn state is invalid.",
      retryable: false,
    };
  }

  const messages = [
    ...input.state.messages,
    {
      role: "user" as const,
      content: orderResults(assistantBlocks, [
        ...input.state.completedResults,
        ...delegatedBlocks,
      ]),
    },
  ];

  return runLoop(
    {
      model: input.model,
      registry: input.registry,
      conversationId: input.conversationId,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ticket: input.state.ticket,
      messages,
      toolContext: input.toolContext,
      retainedArtifacts,
      ...(input.serverToolHandlers
        ? { serverToolHandlers: input.serverToolHandlers }
        : {}),
      pendingTurns: input.pendingTurns,
      ...(input.writeProposals ? { writeProposals: input.writeProposals } : {}),
    },
    deduplicateCitations(citations),
    events,
    {
      remainingModelCalls: input.state.remainingModelCalls,
      deadlineAt: input.state.deadlineAt,
    },
  );
}
