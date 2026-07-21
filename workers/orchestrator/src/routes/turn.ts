import {
  ActionConfirmationRequiredResponseSchema,
  AssistantMessageResponseSchema,
  AnthropicEffortSchema,
  AnthropicModelSchema,
  ContinueTurnRequestSchema,
  DelegatedToolResponseSchema,
  TurnRequestSchema,
  ZendeskListVoicemailsOutputSchema,
  ZendeskReadVoicemailTranscriptChunkInputSchema,
  ZendeskTranscribeVoicemailInputSchema,
  ZendeskVoicemailArtifactSchema,
  type ErrorResponse,
  type TicketBrand,
} from "@resolve/contracts";
import { skillRegistry } from "@resolve/skills";

import {
  readCredentials,
  resolveWooStoreForBrand,
  wooCredentialSourceForStore,
  type WooCredentialSource,
} from "../http/credentials";
import { errorResponse } from "../http/errors";
import { readJsonBody } from "../http/json";
import {
  embedKnowledgeDocuments,
  embedKnowledgeQuery,
} from "../knowledge/embed";
import { searchKnowledge } from "../knowledge/search";
import { AnthropicModelClient } from "../model/anthropic-client";
import {
  parsePendingTurnState,
  resumeTurn,
  runTurn,
  type RunTurnResult,
  type DelegatedResultAdapters,
  type ServerToolHandlers,
} from "../orchestration/run-turn";
import { ConversationRepository } from "../repositories/conversations";
import { KnowledgeRepository } from "../repositories/knowledge";
import { PendingTurnRepository } from "../repositories/pending-turns";
import { WriteProposalRepository } from "../repositories/write-proposals";
import {
  readVoicemailTranscriptChunk,
  retainZendeskVoicemails,
  retainVoicemailTranscript,
  transcribeVoicemail,
} from "../services/transcription";

function tenant(request: Request): string {
  return request.headers.get("x-resolve-tenant")?.trim() ?? "";
}

function anthropicSettings(credentials: ReturnType<typeof readCredentials>) {
  const model = AnthropicModelSchema.safeParse(credentials.anthropicModel);
  const effort = AnthropicEffortSchema.safeParse(credentials.anthropicEffort);
  return model.success && effort.success
    ? { model: model.data, effort: effort.data }
    : undefined;
}

function wooSource(
  brand: TicketBrand,
  env: Env,
): WooCredentialSource | undefined {
  const store = resolveWooStoreForBrand(brand);
  return store ? wooCredentialSourceForStore(store, env) : undefined;
}

function toolContext(
  request: Request,
  woo: WooCredentialSource,
  ticketId: number,
) {
  return {
    signal: request.signal,
    credentials: { ...readCredentials(request.headers, woo) },
    tenantKey: tenant(request),
    ticketId,
  };
}

function serverToolHandlers(env: Env, baseUrl: string): ServerToolHandlers {
  const knowledge = new KnowledgeRepository({
    db: env.DB,
    bucket: env.KNOWLEDGE_BUCKET,
    index: env.KNOWLEDGE_INDEX,
    embedDocuments: (documents) => embedKnowledgeDocuments(env.AI, documents),
  });
  return {
    knowledge_search(input) {
      return searchKnowledge(input, {
        embedQuery: (query) => embedKnowledgeQuery(env.AI, query),
        index: {
          query: (vector, options) =>
            env.KNOWLEDGE_INDEX.query(vector, options),
        },
        loadChunks: (vectorIds) => knowledge.getChunksByVectorIds(vectorIds),
        baseUrl,
      });
    },
    async zendesk_transcribe_voicemail(input, context) {
      const { handle } = ZendeskTranscribeVoicemailInputSchema.parse(input);
      const transcript = await transcribeVoicemail(
        ZendeskVoicemailArtifactSchema.parse(context.retainedArtifacts[handle]),
        context.signal,
        env.AI,
      );
      return retainVoicemailTranscript(transcript, (artifactHandle, value) => {
        context.retainArtifact(artifactHandle, value);
      });
    },
    zendesk_read_voicemail_transcript_chunk(input, context) {
      const parsed =
        ZendeskReadVoicemailTranscriptChunkInputSchema.parse(input);
      return Promise.resolve(
        readVoicemailTranscriptChunk(
          parsed,
          context.retainedArtifacts[parsed.handle],
        ),
      );
    },
  };
}

function delegatedResultAdapters(): DelegatedResultAdapters {
  return {
    zendesk_list_voicemails(output) {
      return retainZendeskVoicemails(
        ZendeskListVoicemailsOutputSchema.parse(output),
      );
    },
  };
}

async function persistToolEvents(
  repository: ConversationRepository,
  conversationId: string,
  messageId: string,
  result: Extract<RunTurnResult, { kind: "completed" }>,
): Promise<void> {
  for (const event of result.toolEvents) {
    const run = await repository.appendToolRun(conversationId, {
      messageId,
      skillId: event.skillId,
      toolName: event.toolName,
      requestSummary: {},
    });
    await repository.completeToolRun(run.id, {
      status: event.status === "failed" ? "failed" : "succeeded",
      resultSummary: { summary: event.summary },
      ...(event.status === "failed" ? { safeErrorCode: "tool_failed" } : {}),
    });
  }
}

async function resultResponse(
  result: RunTurnResult,
  conversationId: string,
  repository: ConversationRepository,
): Promise<Response> {
  if (result.kind === "delegated") {
    return Response.json(
      DelegatedToolResponseSchema.parse({
        kind: "delegated_tool_request",
        turnId: result.turnId,
        requests: result.requests,
      }),
    );
  }
  if (result.kind === "confirmation_required") {
    return Response.json(
      ActionConfirmationRequiredResponseSchema.parse({
        kind: "action_confirmation_required",
        conversationId,
        proposal: result.proposal,
        capability: result.capability,
      }),
    );
  }
  if (result.kind === "error") {
    let externalPartial: ErrorResponse["partial"];
    if (result.partial) {
      const partialMessage = await repository.appendMessage(conversationId, {
        role: "assistant",
        content: result.partial.content,
        citations: result.partial.citations,
        toolEvents: result.partial.toolEvents,
      });
      await persistToolEvents(repository, conversationId, partialMessage.id, {
        kind: "completed",
        text: result.partial.content,
        citations: result.partial.citations,
        toolEvents: result.partial.toolEvents,
        messages: [],
      });
      externalPartial = {
        conversationId,
        messageId: partialMessage.id,
        ...result.partial,
      };
    }
    return errorResponse(
      result.code === "orchestration_limit" ? 429 : 422,
      result.code,
      result.message,
      result.retryable,
      undefined,
      externalPartial,
    );
  }

  const message = await repository.appendMessage(conversationId, {
    role: "assistant",
    content: result.text,
    citations: result.citations,
    toolEvents: result.toolEvents,
  });
  await persistToolEvents(repository, conversationId, message.id, result);
  return Response.json(
    AssistantMessageResponseSchema.parse({
      kind: "assistant_message",
      conversationId,
      messageId: message.id,
      content: result.text,
      citations: result.citations,
      toolEvents: result.toolEvents,
    }),
  );
}

export async function handleTurn(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = TurnRequestSchema.parse(await readJsonBody(request));
  const woo = wooSource(body.ticket.brand, env);
  if (!woo) {
    return errorResponse(
      400,
      "configuration_error",
      `Brand ${body.ticket.brand.name} is not mapped to a WooCommerce store.`,
      false,
      "woocommerce",
    );
  }
  const credentials = readCredentials(request.headers, woo);
  if (!credentials.anthropicApiKey) {
    return errorResponse(
      400,
      "configuration_error",
      "Anthropic is not configured.",
      false,
      "anthropic",
    );
  }
  const selectedAnthropic = anthropicSettings(credentials);
  if (!selectedAnthropic) {
    return errorResponse(
      400,
      "configuration_error",
      "Anthropic model or effort setting is invalid.",
      false,
      "anthropic",
    );
  }

  const conversations = new ConversationRepository(env.DB);
  let conversation;
  if (body.conversationId) {
    conversation = await conversations.get(
      tenant(request),
      body.conversationId,
    );
    if (!conversation || conversation.ticketId !== body.ticket.ticketId) {
      return errorResponse(
        404,
        "validation_error",
        "Conversation was not found.",
        false,
      );
    }
  } else {
    conversation = await conversations.create(
      tenant(request),
      body.ticket.ticketId,
    );
  }

  await conversations.appendMessage(conversation.id, {
    role: "user",
    content: body.message,
    agent: body.agent,
  });
  const storedMessages = await conversations.listMessages(
    tenant(request),
    conversation.id,
  );
  const model = new AnthropicModelClient(
    credentials.anthropicApiKey,
    selectedAnthropic.model,
    selectedAnthropic.effort,
  );
  const result = await runTurn({
    model,
    registry: skillRegistry,
    conversationId: conversation.id,
    agentId: body.agent.id,
    ticket: body.ticket,
    messages: storedMessages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    toolContext: toolContext(request, woo, body.ticket.ticketId),
    serverToolHandlers: serverToolHandlers(env, new URL(request.url).origin),
    pendingTurns: new PendingTurnRepository(env.DB),
    writeProposals: new WriteProposalRepository(env.DB),
  });
  return resultResponse(result, conversation.id, conversations);
}

export async function handleContinueTurn(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = ContinueTurnRequestSchema.parse(await readJsonBody(request));
  const pending = new PendingTurnRepository(env.DB);
  const saved = await pending.consume(body.turnId);
  if (!saved) {
    return errorResponse(
      404,
      "validation_error",
      "Pending turn was not found or was already consumed.",
      false,
    );
  }
  const conversations = new ConversationRepository(env.DB);
  const conversation = await conversations.get(
    tenant(request),
    saved.conversationId,
  );
  if (!conversation) {
    return errorResponse(
      404,
      "validation_error",
      "Conversation was not found.",
      false,
    );
  }
  const state = parsePendingTurnState(saved.state);
  const woo = wooSource(state.ticket.brand, env);
  if (!woo) {
    return errorResponse(
      400,
      "configuration_error",
      `Brand ${state.ticket.brand.name} is not mapped to a WooCommerce store.`,
      false,
      "woocommerce",
    );
  }
  const credentials = readCredentials(request.headers, woo);
  if (!credentials.anthropicApiKey) {
    return errorResponse(
      400,
      "configuration_error",
      "Anthropic is not configured.",
      false,
      "anthropic",
    );
  }
  const selectedAnthropic = anthropicSettings(credentials);
  if (!selectedAnthropic) {
    return errorResponse(
      400,
      "configuration_error",
      "Anthropic model or effort setting is invalid.",
      false,
      "anthropic",
    );
  }
  const result = await resumeTurn({
    model: new AnthropicModelClient(
      credentials.anthropicApiKey,
      selectedAnthropic.model,
      selectedAnthropic.effort,
    ),
    registry: skillRegistry,
    conversationId: conversation.id,
    ...(state.agentId === undefined ? {} : { agentId: state.agentId }),
    state,
    delegatedResults: body.results,
    toolContext: toolContext(request, woo, conversation.ticketId),
    delegatedResultAdapters: delegatedResultAdapters(),
    serverToolHandlers: serverToolHandlers(env, new URL(request.url).origin),
    pendingTurns: pending,
    writeProposals: new WriteProposalRepository(env.DB),
  });
  return resultResponse(result, conversation.id, conversations);
}
