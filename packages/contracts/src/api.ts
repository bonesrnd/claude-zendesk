import { z } from "zod";

import { ActionConfirmationRequiredResponseSchema } from "./actions";
import { CitationSchema, TicketContextSchema, ToolEventSchema } from "./domain";

export const AnthropicModelSchema = z
  .string()
  .trim()
  .regex(/^claude-[a-z0-9][a-z0-9-]{1,99}$/);

export const AnthropicEffortSchema = z.enum([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export type AnthropicEffort = z.infer<typeof AnthropicEffortSchema>;

export const AgentIdentitySchema = z.strictObject({
  id: z.number().int().positive(),
  name: z.string().min(1).max(200),
});

export const TurnRequestSchema = z.strictObject({
  conversationId: z.string().min(1).max(100).optional(),
  message: z.string().min(1).max(20_000),
  ticket: TicketContextSchema,
  agent: AgentIdentitySchema,
});

export const ContinueTurnRequestSchema = z.strictObject({
  turnId: z.string().min(1).max(100),
  results: z
    .array(
      z.strictObject({
        toolUseId: z.string().min(1).max(200),
        toolName: z.string().min(1).max(200),
        output: z.unknown(),
        isError: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(10),
});

export const AssistantMessageResponseSchema = z.strictObject({
  kind: z.literal("assistant_message"),
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
  content: z.string(),
  citations: z.array(CitationSchema),
  toolEvents: z.array(ToolEventSchema),
});

export const DelegatedToolResponseSchema = z.strictObject({
  kind: z.literal("delegated_tool_request"),
  turnId: z.string().min(1),
  requests: z
    .array(
      z.strictObject({
        toolUseId: z.string().min(1),
        toolName: z.string().min(1),
        input: z.unknown(),
      }),
    )
    .min(1),
});

export const ErrorResponseSchema = z.strictObject({
  kind: z.literal("error"),
  code: z.enum([
    "unauthorized",
    "validation_error",
    "configuration_error",
    "integration_error",
    "rate_limited",
    "orchestration_limit",
    "persistence_error",
  ]),
  message: z.string(),
  retryable: z.boolean(),
  integration: z.string().optional(),
  partial: z
    .strictObject({
      conversationId: z.string().min(1),
      messageId: z.string().min(1),
      content: z.string(),
      citations: z.array(CitationSchema),
      toolEvents: z.array(ToolEventSchema),
    })
    .optional(),
});

export const TurnResponseSchema = z.discriminatedUnion("kind", [
  AssistantMessageResponseSchema,
  DelegatedToolResponseSchema,
  ActionConfirmationRequiredResponseSchema,
  ErrorResponseSchema,
]);

export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;
export type TurnRequest = z.infer<typeof TurnRequestSchema>;
export type ContinueTurnRequest = z.infer<typeof ContinueTurnRequestSchema>;
export type AssistantMessageResponse = z.infer<
  typeof AssistantMessageResponseSchema
>;
export type DelegatedToolResponse = z.infer<typeof DelegatedToolResponseSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type TurnResponse = z.infer<typeof TurnResponseSchema>;
