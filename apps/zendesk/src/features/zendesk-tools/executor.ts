import {
  CitationSchema,
  ZendeskCustomerProfileValuesSchema,
  ZendeskGetCustomerProfileInputSchema,
  ZendeskGetCustomerProfileOutputSchema,
  ZendeskGetRequesterTicketsInputSchema,
  ZendeskGetTicketCustomFieldsInputSchema,
  ZendeskGetTicketCustomFieldsOutputSchema,
  ZendeskGetTicketInputSchema,
  ZendeskGetTicketOutputSchema,
  ZendeskListTicketFieldDefinitionsInputSchema,
  ZendeskListTicketFieldDefinitionsOutputSchema,
  ZendeskListVoicemailsInputSchema,
  ZendeskListVoicemailsOutputSchema,
  ZendeskSearchSolvedTicketsInputSchema,
  ZendeskTicketSearchOutputSchema,
  ZendeskTicketSummarySchema,
  ZendeskUpdateCustomerProfileInputSchema,
  ZendeskUpdateTicketCustomFieldsInputSchema,
  ZendeskVerifiedWriteOutputSchema,
  ZendeskVoicemailSchema,
  type DelegatedToolResponse,
  type WriteProposal,
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
      id: z.number().int().positive().optional(),
      type: z.string().optional(),
      recording_url: z.string().optional(),
      transcription_text: z.string().nullable().optional(),
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

const TicketFieldsResponseSchema = z.object({
  ticket_fields: z.array(
    z.object({
      id: z.number().int().positive(),
      title: z.string(),
      type: z.string(),
      active: z.boolean(),
      regexp_for_validation: z.string().nullable().optional(),
      custom_field_options: z
        .array(
          z.object({
            name: z.string(),
            value: z.union([z.string(), z.number(), z.boolean()]),
          }),
        )
        .optional()
        .default([]),
    }),
  ),
});

const CurrentTicketResponseSchema = z.object({
  ticket: z.object({
    id: z.number().int().positive(),
    updated_at: z.string().min(1),
    custom_fields: z
      .array(
        z.object({
          id: z.number().int().positive(),
          value: z.unknown(),
        }),
      )
      .optional()
      .default([]),
  }),
});

const CurrentUserResponseSchema = z.object({
  user: z.object({
    id: z.number().int().positive(),
    updated_at: z.string().min(1),
    name: z.string(),
    phone: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    organization_id: z.number().int().positive().nullable().optional(),
    user_fields: z.record(z.string(), z.unknown()).optional().default({}),
  }),
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
  return ticketCitation(ticket.ticketId, ticket.url);
}

function ticketCitation(ticketId: number, url: string) {
  return CitationSchema.parse({
    provider: "zendesk",
    label: `Ticket ${ticketId}`,
    providerId: String(ticketId),
    url,
  });
}

type CurrentTicket = z.infer<typeof CurrentTicketResponseSchema>["ticket"];
type CurrentUser = z.infer<typeof CurrentUserResponseSchema>["user"];
type ProfileValues = z.infer<typeof ZendeskCustomerProfileValuesSchema>;

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function ticketCustomFields(ticket: CurrentTicket): Record<string, unknown> {
  return Object.fromEntries(
    ticket.custom_fields.map((field) => [String(field.id), field.value]),
  );
}

function profileValues(user: CurrentUser): ProfileValues {
  return ZendeskCustomerProfileValuesSchema.parse({
    name: user.name,
    phone: user.phone ?? null,
    notes: user.notes ?? null,
    organization_id: user.organization_id ?? null,
    user_fields: user.user_fields,
  });
}

function selectedProfileValues(
  profile: ProfileValues,
  template: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(template).map(([key, value]) => {
      if (key !== "user_fields")
        return [key, profile[key as keyof ProfileValues]];
      const requested = z.record(z.string(), z.unknown()).parse(value);
      const userFields = profile.user_fields ?? {};
      return [
        key,
        Object.fromEntries(
          Object.keys(requested).map((field) => [field, userFields[field]]),
        ),
      ];
    }),
  );
}

function normalizedTicketFields(
  response: z.infer<typeof TicketFieldsResponseSchema>,
) {
  return ZendeskListTicketFieldDefinitionsOutputSchema.parse({
    fields: response.ticket_fields.map((field) => ({
      id: field.id,
      title: field.title,
      type: field.type,
      active: field.active,
      options: field.custom_field_options,
      ...(field.regexp_for_validation
        ? { regexpForValidation: field.regexp_for_validation }
        : {}),
    })),
  }).fields;
}

async function readTicketFieldDefinitions(client: ZafClient) {
  const response = TicketFieldsResponseSchema.parse(
    await client.request({
      url: "/api/v2/ticket_fields.json",
      type: "GET",
      autoRetry: true,
    }),
  );
  return normalizedTicketFields(response);
}

async function readCurrentTicket(client: ZafClient, ticketId: number) {
  return CurrentTicketResponseSchema.parse(
    await client.request({
      url: `/api/v2/tickets/${ticketId}.json`,
      type: "GET",
      autoRetry: true,
    }),
  ).ticket;
}

async function readCurrentUser(client: ZafClient, userId: number) {
  return CurrentUserResponseSchema.parse(
    await client.request({
      url: `/api/v2/users/${userId}.json`,
      type: "GET",
      autoRetry: true,
    }),
  ).user;
}

type TicketFieldDefinition = Awaited<
  ReturnType<typeof readTicketFieldDefinitions>
>[number];

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isIntegerValue(value: unknown): boolean {
  return (
    (typeof value === "number" && Number.isInteger(value)) ||
    (typeof value === "string" && /^-?\d+$/.test(value))
  );
}

function isDecimalValue(value: unknown): boolean {
  return (
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && /^-?(?:\d+|\d+\.\d+|\.\d+)$/.test(value))
  );
}

function validateTicketFieldShape(
  definition: TicketFieldDefinition,
  value: unknown,
  allowNull: boolean,
): void {
  if (allowNull && value === null) return;
  let valid = false;
  switch (definition.type) {
    case "checkbox":
      valid = typeof value === "boolean";
      break;
    case "multiselect":
      valid =
        Array.isArray(value) &&
        value.every((option) => typeof option === "string");
      break;
    case "dropdown":
    case "tagger":
      valid = typeof value === "string";
      break;
    case "date":
      valid = typeof value === "string" && isCalendarDate(value);
      break;
    case "integer":
      valid = isIntegerValue(value);
      break;
    case "decimal":
      valid = isDecimalValue(value);
      break;
    case "text":
    case "textarea":
      valid = typeof value === "string";
      break;
    case "regexp":
      if (typeof value !== "string") break;
      if (allowNull) {
        valid = true;
        break;
      }
      if (!definition.regexpForValidation) break;
      try {
        valid = new RegExp(definition.regexpForValidation).test(value);
      } catch {
        valid = false;
      }
      break;
  }
  if (!valid) {
    throw new Error(
      `Ticket field ${definition.id} has an invalid ${definition.type} value`,
    );
  }
}

function validateTicketChanges(
  before: Record<string, unknown>,
  changes: Record<string, unknown>,
  current: CurrentTicket,
  definitions: Awaited<ReturnType<typeof readTicketFieldDefinitions>>,
): void {
  const currentValues = ticketCustomFields(current);
  for (const [fieldId, after] of Object.entries(changes)) {
    if (!Object.hasOwn(before, fieldId)) {
      throw new Error(`Ticket field ${fieldId} is missing its before value`);
    }
    if (!sameValue(before[fieldId], currentValues[fieldId])) {
      throw new Error(
        "The Zendesk record changed after this write was proposed",
      );
    }
    const definition = definitions.find(
      (field) => String(field.id) === fieldId,
    );
    if (!definition?.active) {
      throw new Error(`Ticket field ${fieldId} is inactive or unavailable`);
    }
    validateTicketFieldShape(definition, before[fieldId], true);
    validateTicketFieldShape(definition, after, false);
    const proposedOptions = Array.isArray(after) ? after : [after];
    if (
      definition.options.length > 0 &&
      !proposedOptions.every((value) =>
        definition.options.some((option) => sameValue(option.value, value)),
      )
    ) {
      throw new Error(`Ticket field ${fieldId} has an invalid option value`);
    }
  }
}

function validateProfileChanges(
  before: Record<string, unknown>,
  changes: Record<string, unknown>,
  current: CurrentUser,
): void {
  const parsedBefore = ZendeskCustomerProfileValuesSchema.parse(before);
  const parsedChanges = ZendeskCustomerProfileValuesSchema.parse(changes);
  const currentProfile = profileValues(current);
  for (const [field, after] of Object.entries(parsedChanges)) {
    if (!Object.hasOwn(parsedBefore, field)) {
      throw new Error(`Profile field ${field} is missing its before value`);
    }
    if (field === "user_fields") {
      const beforeFields = parsedBefore.user_fields ?? {};
      const changedFields = z.record(z.string(), z.unknown()).parse(after);
      for (const customField of Object.keys(changedFields)) {
        if (!Object.hasOwn(current.user_fields, customField)) {
          throw new Error(
            `Customer user field ${customField} is not configured`,
          );
        }
        if (
          !Object.hasOwn(beforeFields, customField) ||
          !sameValue(
            beforeFields[customField],
            current.user_fields[customField],
          )
        ) {
          throw new Error(
            "The Zendesk record changed after this write was proposed",
          );
        }
      }
      continue;
    }
    if (
      !sameValue(
        parsedBefore[field as keyof ProfileValues],
        currentProfile[field as keyof ProfileValues],
      )
    ) {
      throw new Error(
        "The Zendesk record changed after this write was proposed",
      );
    }
  }
}

export async function inspectZendeskProposal(
  client: ZafClient,
  proposal: WriteProposal,
): Promise<{ recordVersion: string }> {
  if (proposal.action === "zendesk_update_ticket_custom_fields") {
    const ticket = await readCurrentTicket(client, proposal.targetId);
    const definitions = await readTicketFieldDefinitions(client);
    validateTicketChanges(
      proposal.before,
      proposal.changes,
      ticket,
      definitions,
    );
    return { recordVersion: ticket.updated_at };
  }

  const user = await readCurrentUser(client, proposal.targetId);
  validateProfileChanges(proposal.before, proposal.changes, user);
  return { recordVersion: user.updated_at };
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

async function listVoicemails(
  client: ZafClient,
  input: unknown,
  subdomain: string,
): Promise<unknown> {
  const { ticketId } = ZendeskListVoicemailsInputSchema.parse(input);
  const response = CommentsResponseSchema.parse(
    await client.request({
      url: `/api/v2/tickets/${ticketId}/comments.json?sort_order=desc`,
      type: "GET",
      autoRetry: true,
    }),
  );
  const voicemails = response.comments
    .flatMap((comment) => {
      if (
        comment.type !== "VoiceComment" ||
        comment.id === undefined ||
        comment.recording_url === undefined
      ) {
        return [];
      }
      const createdAt = new Date(comment.created_at);
      if (Number.isNaN(createdAt.getTime())) return [];
      const parsed = ZendeskVoicemailSchema.safeParse({
        ticketId,
        commentId: comment.id,
        recordingUrl: comment.recording_url,
        transcriptionText: comment.transcription_text ?? "",
        createdAt: createdAt.toISOString(),
      });
      return parsed.success ? [parsed.data] : [];
    })
    .slice(0, 30);
  return ZendeskListVoicemailsOutputSchema.parse({
    voicemails,
    citations: [ticketCitation(ticketId, ticketUrl(subdomain, ticketId))],
  });
}

async function listTicketFieldDefinitions(
  client: ZafClient,
  input: unknown,
): Promise<unknown> {
  ZendeskListTicketFieldDefinitionsInputSchema.parse(input);
  return ZendeskListTicketFieldDefinitionsOutputSchema.parse({
    fields: await readTicketFieldDefinitions(client),
  });
}

async function getTicketCustomFields(
  client: ZafClient,
  input: unknown,
): Promise<unknown> {
  const { ticketId } = ZendeskGetTicketCustomFieldsInputSchema.parse(input);
  const ticket = await readCurrentTicket(client, ticketId);
  return ZendeskGetTicketCustomFieldsOutputSchema.parse({
    ticketId: ticket.id,
    recordVersion: ticket.updated_at,
    customFields: ticketCustomFields(ticket),
  });
}

async function getCustomerProfile(
  client: ZafClient,
  input: unknown,
): Promise<unknown> {
  const { userId } = ZendeskGetCustomerProfileInputSchema.parse(input);
  const user = await readCurrentUser(client, userId);
  return ZendeskGetCustomerProfileOutputSchema.parse({
    userId: user.id,
    recordVersion: user.updated_at,
    profile: profileValues(user),
  });
}

function profileUpdatePayload(changes: ProfileValues): Record<string, unknown> {
  return {
    ...("name" in changes ? { name: changes.name } : {}),
    ...("phone" in changes ? { phone: changes.phone } : {}),
    ...("notes" in changes ? { notes: changes.notes } : {}),
    ...("organization_id" in changes
      ? { organization_id: changes.organization_id }
      : {}),
    ...("user_fields" in changes ? { user_fields: changes.user_fields } : {}),
  };
}

function assertVerifiedChanges(
  changes: Record<string, unknown>,
  after: Record<string, unknown>,
): void {
  for (const [field, value] of Object.entries(changes)) {
    if (!sameValue(value, after[field])) {
      throw new Error(`Zendesk did not persist the proposed ${field} value`);
    }
  }
}

export async function executeConfirmedZendeskAction(
  client: ZafClient,
  request: DelegatedRequest,
  subdomain: string,
): Promise<DelegatedToolResult> {
  void subdomain;
  let output: unknown;
  if (request.toolName === "zendesk_update_ticket_custom_fields") {
    const input = ZendeskUpdateTicketCustomFieldsInputSchema.parse(
      request.input,
    );
    const current = await readCurrentTicket(client, input.ticketId);
    if (current.updated_at !== input.recordVersion) {
      throw new Error("The Zendesk record changed before confirmation");
    }
    const definitions = await readTicketFieldDefinitions(client);
    validateTicketChanges(input.before, input.changes, current, definitions);
    await client.request({
      url: `/api/v2/tickets/${input.ticketId}.json`,
      type: "PUT",
      autoRetry: false,
      contentType: "application/json",
      data: JSON.stringify({
        ticket: {
          custom_fields: Object.entries(input.changes).map(([id, value]) => ({
            id: Number(id),
            value,
          })),
        },
      }),
    });
    const refetched = await readCurrentTicket(client, input.ticketId);
    const refetchedFields = ticketCustomFields(refetched);
    const after = Object.fromEntries(
      Object.keys(input.changes).map((field) => [
        field,
        refetchedFields[field],
      ]),
    );
    assertVerifiedChanges(input.changes, after);
    output = ZendeskVerifiedWriteOutputSchema.parse({
      targetId: input.ticketId,
      recordVersion: refetched.updated_at,
      before: input.before,
      after,
      verified: true,
    });
  } else if (request.toolName === "zendesk_update_customer_profile") {
    const input = ZendeskUpdateCustomerProfileInputSchema.parse(request.input);
    const current = await readCurrentUser(client, input.userId);
    if (current.updated_at !== input.recordVersion) {
      throw new Error("The Zendesk record changed before confirmation");
    }
    validateProfileChanges(input.before, input.changes, current);
    await client.request({
      url: `/api/v2/users/${input.userId}.json`,
      type: "PUT",
      autoRetry: false,
      contentType: "application/json",
      data: JSON.stringify({ user: profileUpdatePayload(input.changes) }),
    });
    const refetched = await readCurrentUser(client, input.userId);
    const after = selectedProfileValues(
      profileValues(refetched),
      input.changes,
    );
    assertVerifiedChanges(input.changes, after);
    output = ZendeskVerifiedWriteOutputSchema.parse({
      targetId: input.userId,
      recordVersion: refetched.updated_at,
      before: input.before,
      after,
      verified: true,
    });
  } else {
    throw new Error(`Unsupported confirmed action ${request.toolName}`);
  }

  return {
    toolUseId: request.toolUseId,
    toolName: request.toolName,
    output,
    isError: false,
  };
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
  } else if (request.toolName === "zendesk_list_voicemails") {
    output = await listVoicemails(client, request.input, subdomain);
  } else if (request.toolName === "zendesk_list_ticket_field_definitions") {
    output = await listTicketFieldDefinitions(client, request.input);
  } else if (request.toolName === "zendesk_get_ticket_custom_fields") {
    output = await getTicketCustomFields(client, request.input);
  } else if (request.toolName === "zendesk_get_customer_profile") {
    output = await getCustomerProfile(client, request.input);
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
