import { z } from "zod";

import { CitationSchema } from "./domain";

export const ZendeskTicketSummarySchema = z.strictObject({
  ticketId: z.number().int().positive(),
  subject: z.string().max(500),
  status: z.string().min(1).max(100),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  snippet: z.string().max(2_000),
  url: z.url(),
});

export const ZendeskTicketCommentSchema = z.strictObject({
  authorName: z.string().max(200),
  body: z.string().max(20_000),
  createdAt: z.iso.datetime(),
  public: z.boolean(),
});

export const ZendeskTicketDetailSchema = ZendeskTicketSummarySchema.extend({
  comments: z.array(ZendeskTicketCommentSchema).max(30),
});

export const ZendeskGetRequesterTicketsInputSchema = z.strictObject({
  requesterId: z.number().int().positive(),
  limit: z.number().int().min(1).max(20).default(10),
});

export const ZendeskSearchSolvedTicketsInputSchema = z.strictObject({
  terms: z.array(z.string().trim().min(1).max(100)).min(1).max(8),
  limit: z.number().int().min(1).max(20).default(10),
  brandId: z.number().int().positive().optional(),
  formId: z.number().int().positive().optional(),
  organizationId: z.number().int().positive().optional(),
});

export const ZendeskGetTicketInputSchema = z.strictObject({
  ticketId: z.number().int().positive(),
});

export const ZendeskListTicketFieldDefinitionsInputSchema = z.strictObject({});

export const ZendeskTicketFieldOptionSchema = z.strictObject({
  name: z.string().trim().min(1).max(500),
  value: z.union([z.string().max(2_000), z.number(), z.boolean()]),
});

export const ZendeskTicketFieldDefinitionSchema = z.strictObject({
  id: z.number().int().positive(),
  title: z.string().trim().min(1).max(500),
  type: z.string().trim().min(1).max(100),
  active: z.boolean(),
  options: z.array(ZendeskTicketFieldOptionSchema).max(1_000),
  regexpForValidation: z.string().max(2_000).optional(),
});

export const ZendeskListTicketFieldDefinitionsOutputSchema = z.strictObject({
  fields: z.array(ZendeskTicketFieldDefinitionSchema).max(1_000),
});

const ZendeskCustomFieldValuesSchema = z
  .record(z.string().regex(/^\d+$/), z.unknown())
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one ticket custom field is required",
  });

export const ZendeskGetTicketCustomFieldsInputSchema =
  ZendeskGetTicketInputSchema;

export const ZendeskGetTicketCustomFieldsOutputSchema = z.strictObject({
  ticketId: z.number().int().positive(),
  recordVersion: z.string().trim().min(1).max(200),
  customFields: z.record(z.string().regex(/^\d+$/), z.unknown()),
});

export const ZendeskGetCustomerProfileInputSchema = z.strictObject({
  userId: z.number().int().positive(),
});

const ZendeskUserFieldsSchema = z.record(
  z.string().trim().min(1).max(200),
  z.unknown(),
);

export const ZendeskCustomerProfileValuesSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200).optional(),
    phone: z.string().trim().max(100).nullable().optional(),
    notes: z.string().max(20_000).nullable().optional(),
    organization_id: z.number().int().positive().nullable().optional(),
    user_fields: ZendeskUserFieldsSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one approved profile field is required",
  });

export const ZendeskGetCustomerProfileOutputSchema = z.strictObject({
  userId: z.number().int().positive(),
  recordVersion: z.string().trim().min(1).max(200),
  profile: ZendeskCustomerProfileValuesSchema,
});

export const ZendeskUpdateTicketCustomFieldsInputSchema = z.strictObject({
  ticketId: z.number().int().positive(),
  recordVersion: z.string().trim().min(1).max(200),
  before: ZendeskCustomFieldValuesSchema,
  changes: ZendeskCustomFieldValuesSchema,
});

export const ZendeskUpdateCustomerProfileInputSchema = z.strictObject({
  userId: z.number().int().positive(),
  recordVersion: z.string().trim().min(1).max(200),
  before: ZendeskCustomerProfileValuesSchema,
  changes: ZendeskCustomerProfileValuesSchema,
});

export const ZendeskVerifiedWriteOutputSchema = z.strictObject({
  targetId: z.number().int().positive(),
  recordVersion: z.string().trim().min(1).max(200),
  before: z.record(z.string().trim().min(1).max(200), z.unknown()),
  after: z.record(z.string().trim().min(1).max(200), z.unknown()),
  verified: z.literal(true),
});

export const ZendeskVoicemailSchema = z.strictObject({
  ticketId: z.number().int().positive(),
  commentId: z.number().int().positive(),
  recordingUrl: z
    .url()
    .refine(
      (value) => URL.canParse(value) && new URL(value).protocol === "https:",
      {
        message: "Zendesk recording URLs must use HTTPS",
      },
    ),
  transcriptionText: z.string().max(100_000),
  createdAt: z.iso.datetime(),
});

export const ZendeskListVoicemailsInputSchema = ZendeskGetTicketInputSchema;

export const ZendeskListVoicemailsOutputSchema = z.strictObject({
  voicemails: z.array(ZendeskVoicemailSchema).max(30),
  citations: z.array(CitationSchema).max(1),
});

export const ZendeskTranscriptSegmentSchema = z
  .strictObject({
    text: z.string().max(20_000),
    startSecond: z.number().nonnegative(),
    endSecond: z.number().nonnegative(),
  })
  .refine((segment) => segment.endSecond >= segment.startSecond, {
    message: "Transcript segment end must not precede its start",
  });

export const ZendeskVoicemailHandleSchema = z
  .string()
  .regex(
    /^vm_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

export const ZendeskTranscribeVoicemailInputSchema = z.strictObject({
  handle: ZendeskVoicemailHandleSchema,
});

export const ZendeskVoicemailArtifactSchema = z
  .strictObject({
    kind: z.literal("zendesk_voicemail"),
    voicemail: ZendeskVoicemailSchema,
    citation: CitationSchema,
  })
  .superRefine((value, context) => {
    if (
      value.citation.provider !== "zendesk" ||
      value.citation.providerId !== String(value.voicemail.ticketId)
    ) {
      context.addIssue({
        code: "custom",
        message: "Voicemail citation must match its Zendesk ticket",
        path: ["citation"],
      });
    }
  });

export const ZendeskVoicemailTranscriptHandleSchema = z
  .string()
  .regex(
    /^vmt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

export const ZendeskTranscriptionSourceSchema = z.enum([
  "zendesk_existing",
  "cloudflare_workers_ai",
]);

export const ZendeskTranscribeVoicemailOutputSchema = z.strictObject({
  handle: ZendeskVoicemailTranscriptHandleSchema,
  preview: z.string().min(1).max(1_000),
  transcriptLength: z.number().int().positive().max(100_000),
  status: z.enum(["complete", "truncated"]),
  language: z.string().trim().min(1).max(20).optional(),
  source: ZendeskTranscriptionSourceSchema,
  citations: z.array(CitationSchema).length(1),
});

export const ZendeskVoicemailTranscriptArtifactSchema = z.strictObject({
  kind: z.literal("zendesk_voicemail_transcript"),
  text: z.string().trim().min(1).max(100_000),
  language: z.string().trim().min(1).max(20).optional(),
  segments: z.array(ZendeskTranscriptSegmentSchema).max(10_000).optional(),
  source: ZendeskTranscriptionSourceSchema,
  citations: z.array(CitationSchema).length(1),
});

export const ZendeskReadVoicemailTranscriptChunkInputSchema = z.strictObject({
  handle: ZendeskVoicemailTranscriptHandleSchema,
  offset: z.number().int().nonnegative().max(99_999),
  length: z.number().int().min(1).max(2_000),
});

export const ZendeskReadVoicemailTranscriptChunkOutputSchema = z.strictObject({
  handle: ZendeskVoicemailTranscriptHandleSchema,
  offset: z.number().int().nonnegative(),
  text: z.string().min(1).max(2_000),
  transcriptLength: z.number().int().positive().max(100_000),
  nextOffset: z.number().int().positive().max(100_000),
  status: z.enum(["complete", "more"]),
  citations: z.array(CitationSchema).length(1),
});

export const ZendeskTicketSearchOutputSchema = z.strictObject({
  tickets: z.array(ZendeskTicketSummarySchema).max(20),
  citations: z.array(CitationSchema).max(20),
});

export const ZendeskGetTicketOutputSchema = z
  .strictObject({
    ticket: ZendeskTicketDetailSchema.nullable(),
    citations: z.array(CitationSchema).max(1),
  })
  .superRefine((value, context) => {
    if (value.ticket && value.citations.length !== 1) {
      context.addIssue({
        code: "custom",
        message: "A retrieved ticket requires one citation",
        path: ["citations"],
      });
    }
    if (!value.ticket && value.citations.length !== 0) {
      context.addIssue({
        code: "custom",
        message: "An empty ticket result cannot include citations",
        path: ["citations"],
      });
    }
  });

export type ZendeskTicketSummary = z.infer<typeof ZendeskTicketSummarySchema>;
export type ZendeskTicketDetail = z.infer<typeof ZendeskTicketDetailSchema>;
export type ZendeskVoicemail = z.infer<typeof ZendeskVoicemailSchema>;
export type ZendeskVoicemailArtifact = z.infer<
  typeof ZendeskVoicemailArtifactSchema
>;
export type ZendeskVoicemailTranscriptArtifact = z.infer<
  typeof ZendeskVoicemailTranscriptArtifactSchema
>;
export type ZendeskTranscribeVoicemailInput = z.infer<
  typeof ZendeskTranscribeVoicemailInputSchema
>;
export type ZendeskTranscribeVoicemailOutput = z.infer<
  typeof ZendeskTranscribeVoicemailOutputSchema
>;
