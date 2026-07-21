import type { ZodType } from "zod";

export type ToolRisk = "read" | "write";
export type ToolExecution = "server" | "delegated";

export interface ToolWriteProposalDraft {
  action:
    "zendesk_update_ticket_custom_fields" | "zendesk_update_customer_profile";
  targetId: number;
  before: Record<string, unknown>;
  changes: Record<string, unknown>;
  recordVersion: string;
}

export interface ToolExecutionContext {
  signal: AbortSignal;
  credentials: Readonly<Record<string, string | undefined>>;
  tenantKey: string;
  ticketId: number;
}

export interface SkillCredential {
  settingName: string;
  headerName: string;
  required: boolean;
  secret: boolean;
}

export interface ToolDefinition<TInput, TOutput> {
  name: string;
  description: string;
  risk: ToolRisk;
  requiresConfirmation: boolean;
  execution: ToolExecution;
  inputSchema: ZodType<TInput>;
  outputSchema: ZodType<TOutput>;
  createProposal?: (input: TInput) => ToolWriteProposalDraft;
  handler?: (input: TInput, context: ToolExecutionContext) => Promise<TOutput>;
}

export interface RegisteredTool {
  name: string;
  description: string;
  risk: ToolRisk;
  requiresConfirmation: boolean;
  execution: ToolExecution;
  inputSchema: ZodType;
  outputSchema: ZodType;
  createProposal?: (input: unknown) => ToolWriteProposalDraft;
  handler?: (input: unknown, context: ToolExecutionContext) => Promise<unknown>;
}

export interface SkillDefinition {
  id: string;
  name: string;
  version: string;
  instructions: string;
  credentials: readonly SkillCredential[];
  tools: readonly RegisteredTool[];
  isConfigured?: (
    credentials: Readonly<Record<string, string | undefined>>,
  ) => boolean;
  healthCheck?: (
    context: ToolExecutionContext,
  ) => Promise<{ ok: boolean; message: string }>;
}

export function defineTool<TInput, TOutput>(
  tool: ToolDefinition<TInput, TOutput>,
): RegisteredTool {
  if (tool.execution === "server" && !tool.handler) {
    throw new Error(`Server tool ${tool.name} requires a handler`);
  }
  if (tool.execution === "delegated" && tool.handler) {
    throw new Error(`Delegated tool ${tool.name} cannot define a handler`);
  }

  const base: Omit<RegisteredTool, "handler" | "createProposal"> = {
    name: tool.name,
    description: tool.description,
    risk: tool.risk,
    requiresConfirmation: tool.requiresConfirmation,
    execution: tool.execution,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
  };
  const createProposal = tool.createProposal;
  const proposalFactory = createProposal
    ? {
        createProposal(input: unknown) {
          return createProposal(tool.inputSchema.parse(input));
        },
      }
    : {};
  const typedHandler = tool.handler;
  if (!typedHandler) return { ...base, ...proposalFactory };

  return {
    ...base,
    ...proposalFactory,
    async handler(input, context) {
      const parsedInput = tool.inputSchema.parse(input);
      const output = await typedHandler(parsedInput, context);
      return tool.outputSchema.parse(output);
    },
  };
}

export function defineSkill<T extends SkillDefinition>(skill: T): T {
  return skill;
}
