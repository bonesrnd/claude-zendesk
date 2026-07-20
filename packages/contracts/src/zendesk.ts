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
