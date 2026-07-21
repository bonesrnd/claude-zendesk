import { z } from "zod";

export const WriteActionSchema = z.enum([
  "zendesk_update_ticket_custom_fields",
  "zendesk_update_customer_profile",
]);

export const ConfirmationCapabilitySchema = z
  .string()
  .regex(/^confirm_[0-9a-f]{64}$/);

const ProposalValuesSchema = z.record(
  z.string().trim().min(1).max(200),
  z.unknown(),
);

export const WriteProposalSchema = z.strictObject({
  id: z.string().min(1).max(100),
  action: WriteActionSchema,
  targetId: z.number().int().positive(),
  before: ProposalValuesSchema,
  changes: ProposalValuesSchema,
  expiresAt: z.iso.datetime(),
});

export const WriteProposalDraftSchema = WriteProposalSchema.omit({
  id: true,
  expiresAt: true,
}).extend({
  recordVersion: z.string().trim().min(1).max(200),
});

export const ActionConfirmationRequiredResponseSchema = z.strictObject({
  kind: z.literal("action_confirmation_required"),
  conversationId: z.string().min(1).max(100),
  proposal: WriteProposalSchema,
  capability: ConfirmationCapabilitySchema,
});

export const ActionConfirmationRequestSchema = z.strictObject({
  capability: ConfirmationCapabilitySchema,
  recordVersion: z.string().trim().min(1).max(200),
});

export const ActionConfirmationResponseSchema = z.strictObject({
  kind: z.literal("delegated_tool_request"),
  turnId: z.string().min(1).max(100),
  requests: z
    .array(
      z.strictObject({
        toolUseId: z.string().min(1).max(200),
        toolName: WriteActionSchema,
        input: z.unknown(),
      }),
    )
    .length(1),
});

export type WriteAction = z.infer<typeof WriteActionSchema>;
export type WriteProposal = z.infer<typeof WriteProposalSchema>;
export type WriteProposalDraft = z.infer<typeof WriteProposalDraftSchema>;
export type ActionConfirmationRequiredResponse = z.infer<
  typeof ActionConfirmationRequiredResponseSchema
>;
export type ActionConfirmationRequest = z.infer<
  typeof ActionConfirmationRequestSchema
>;
export type ActionConfirmationResponse = z.infer<
  typeof ActionConfirmationResponseSchema
>;
