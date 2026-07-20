import {
  CitationSchema,
  ZendeskGetRequesterTicketsInputSchema,
  ZendeskGetTicketInputSchema,
  ZendeskGetTicketOutputSchema,
  ZendeskSearchSolvedTicketsInputSchema,
  ZendeskTicketSearchOutputSchema,
  ZendeskTicketSummarySchema,
  type DelegatedToolResponse,
  type ZendeskTicketSummary,
} from "@resolve/contracts";
import { z } from "zod";

import type { ZafClient } from "../../types/zaf";

type DelegatedRequest = DelegatedToolResponse["requests"][number];

export interface DelegatedToolResult {
  toolUseId: string;
  toolName: string;
  output: unknown;
  isError: boolean;
}

const SearchResponseSchema = z.object({
  results: z.array(
    z.object({
      id: z.number().int().positive(),
      subject: z.string().nullable().optional(),
      status: z.string(),
      created_at: z.string(),
      updated_at: z.string(),
      description: z.string().nullable().optional(),
    }),
  ),
});

const TicketResponseSchema = z.object({
  ticket: SearchResponseSchema.shape.results.element,
});

const CommentsResponseSchema = z.object({
  comments: z.array(
    z.object({
      author_id: z.number().int().optional(),
      plain_body: z.string().nullable().optional(),
      body: z.string().nullable().optional(),
      created_at: z.string(),
      public: z.boolean().optional().default(true),
      via: z
        .object({
          source: z
            .object({
              from: z
                .object({
                  name: z.string().optional(),
                })
                .optional(),
            })
            .optional(),
        })
        .optional(),
    }),
  ),
});

function zendeskOrigin(subdomain: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(subdomain)) {
    throw new Error("Zendesk subdomain is invalid");
  }
  return `https://${subdomain}.zendesk.com`;
}

function ticketUrl(subdomain: string, ticketId: number): string {
  return `${zendeskOrigin(subdomain)}/agent/tickets/${ticketId}`;
}

function summary(
  result: z.infer<typeof SearchResponseSchema>["results"][number],
  subdomain: string,
): ZendeskTicketSummary {
  return ZendeskTicketSummarySchema.parse({
    ticketId: result.id,
    subject: result.subject ?? "(No subject)",
    status: result.status,
    createdAt: new Date(result.created_at).toISOString(),
    updatedAt: new Date(result.updated_at).toISOString(),
    snippet: (result.description ?? "").slice(0, 2_000),
    url: ticketUrl(subdomain, result.id),
  });
}

function citation(ticket: ZendeskTicketSummary) {
  return CitationSchema.parse({
    provider: "zendesk",
    label: `Ticket ${ticket.ticketId}`,
    providerId: String(ticket.ticketId),
    url: ticket.url,
  });
}

function searchUrl(query: string, limit: number): string {
  const params = new URLSearchParams({
    query,
    sort_by: "updated_at",
    sort_order: "desc",
    per_page: String(limit),
  });
  return `/api/v2/search.json?${params.toString()}`;
}

function quoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function requesterTickets(
  client: ZafClient,
  input: unknown,
  subdomain: string,
): Promise<unknown> {
  const parsed = ZendeskGetRequesterTicketsInputSchema.parse(input);
  const response = SearchResponseSchema.parse(
    await client.request({
      url: searchUrl(
        `type:ticket requester:${parsed.requesterId}`,
        parsed.limit,
      ),
      type: "GET",
      autoRetry: true,
    }),
  );
  const tickets = response.results
    .slice(0, parsed.limit)
    .map((result) => summary(result, subdomain));
  return ZendeskTicketSearchOutputSchema.parse({
    tickets,
    citations: tickets.map(citation),
  });
}

async function solvedTickets(
  client: ZafClient,
  input: unknown,
  subdomain: string,
): Promise<unknown> {
  const parsed = ZendeskSearchSolvedTicketsInputSchema.parse(input);
  const filters = [
    "type:ticket",
    "status:solved",
    ...parsed.terms.map(quoted),
    ...(parsed.brandId ? [`brand:${parsed.brandId}`] : []),
    ...(parsed.formId ? [`ticket_form_id:${parsed.formId}`] : []),
    ...(parsed.organizationId ? [`organization:${parsed.organizationId}`] : []),
  ];
  const response = SearchResponseSchema.parse(
    await client.request({
      url: searchUrl(filters.join(" "), parsed.limit),
      type: "GET",
      autoRetry: true,
    }),
  );
  const tickets = response.results
    .slice(0, parsed.limit)
    .map((result) => summary(result, subdomain));
  return ZendeskTicketSearchOutputSchema.parse({
    tickets,
    citations: tickets.map(citation),
  });
}

async function getTicket(
  client: ZafClient,
  input: unknown,
  subdomain: string,
): Promise<unknown> {
  const { ticketId } = ZendeskGetTicketInputSchema.parse(input);
  const [ticketResponse, commentsResponse] = await Promise.all([
    client.request({
      url: `/api/v2/tickets/${ticketId}.json`,
      type: "GET",
      autoRetry: true,
    }),
    client.request({
      url: `/api/v2/tickets/${ticketId}/comments.json?sort_order=desc`,
      type: "GET",
      autoRetry: true,
    }),
  ]);
  const ticket = summary(
    TicketResponseSchema.parse(ticketResponse).ticket,
    subdomain,
  );
  const comments = CommentsResponseSchema.parse(commentsResponse)
    .comments.slice(0, 30)
    .map((comment) => ({
      authorName:
        comment.via?.source?.from?.name ??
        (comment.author_id ? `Author ${comment.author_id}` : "Unknown"),
      body: (comment.plain_body ?? comment.body ?? "").slice(0, 20_000),
      createdAt: new Date(comment.created_at).toISOString(),
      public: comment.public,
    }));
  return ZendeskGetTicketOutputSchema.parse({
    ticket: { ...ticket, comments },
    citations: [citation(ticket)],
  });
}

export async function executeZendeskTool(
  client: ZafClient,
  request: DelegatedRequest,
  subdomain: string,
): Promise<DelegatedToolResult> {
  let output: unknown;
  if (request.toolName === "zendesk_get_requester_tickets") {
    output = await requesterTickets(client, request.input, subdomain);
  } else if (request.toolName === "zendesk_search_solved_tickets") {
    output = await solvedTickets(client, request.input, subdomain);
  } else if (request.toolName === "zendesk_get_ticket") {
    output = await getTicket(client, request.input, subdomain);
  } else {
    throw new Error(`Unsupported delegated tool ${request.toolName}`);
  }
  return {
    toolUseId: request.toolUseId,
    toolName: request.toolName,
    output,
    isError: false,
  };
}
