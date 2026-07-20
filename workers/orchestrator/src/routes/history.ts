import { z } from "zod";

import { errorResponse } from "../http/errors";
import { ConversationRepository } from "../repositories/conversations";

const TicketIdSchema = z.coerce.number().int().positive();
const ConversationIdSchema = z.string().regex(/^conv_[0-9a-f-]{36}$/i);

function tenant(request: Request): string {
  return request.headers.get("x-resolve-tenant")?.trim() ?? "";
}

export async function handleTicketConversations(
  request: Request,
  env: Env,
  ticketIdValue: string,
): Promise<Response> {
  const ticketId = TicketIdSchema.parse(ticketIdValue);
  const repository = new ConversationRepository(env.DB);
  const conversations = await repository.listForTicket(
    tenant(request),
    ticketId,
  );
  return Response.json({ conversations });
}

export async function handleConversationMessages(
  request: Request,
  env: Env,
  conversationIdValue: string,
): Promise<Response> {
  const conversationId = ConversationIdSchema.parse(conversationIdValue);
  const repository = new ConversationRepository(env.DB);
  const conversation = await repository.get(tenant(request), conversationId);
  if (!conversation) {
    return errorResponse(
      404,
      "validation_error",
      "Conversation was not found.",
      false,
    );
  }
  const [messages, toolRuns] = await Promise.all([
    repository.listMessages(tenant(request), conversationId),
    repository.listToolRuns(tenant(request), conversationId),
  ]);
  return Response.json({ conversation, messages, toolRuns });
}
