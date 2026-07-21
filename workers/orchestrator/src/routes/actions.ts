import {
  ActionConfirmationRequestSchema,
  ActionConfirmationResponseSchema,
} from "@resolve/contracts";

import { errorResponse } from "../http/errors";
import { readJsonBody } from "../http/json";
import { parsePendingTurnState, TURN_LIMITS } from "../orchestration/run-turn";
import { ConversationRepository } from "../repositories/conversations";
import { PendingTurnRepository } from "../repositories/pending-turns";
import {
  WriteProposalRepository,
  type ConfirmWriteProposalResult,
  type StoredWriteProposal,
} from "../repositories/write-proposals";

function tenant(request: Request): string {
  return request.headers.get("x-resolve-tenant")?.trim() ?? "";
}

function confirmationError(
  result: Extract<ConfirmWriteProposalResult, { error: string }>,
): Response {
  if (result.error === "expired") {
    return errorResponse(
      410,
      "validation_error",
      "This write proposal has expired.",
      false,
    );
  }
  if (result.error === "stale") {
    return errorResponse(
      409,
      "validation_error",
      "The Zendesk record changed after this write was proposed.",
      false,
    );
  }
  if (result.error === "not_pending") {
    return errorResponse(
      409,
      "validation_error",
      "This write proposal is no longer pending.",
      false,
    );
  }
  return errorResponse(
    404,
    "validation_error",
    "Write proposal was not found.",
    false,
  );
}

function delegatedInput(proposal: StoredWriteProposal) {
  const base = {
    recordVersion: proposal.recordVersion,
    before: proposal.before,
    changes: proposal.changes,
  };
  return proposal.action === "zendesk_update_ticket_custom_fields"
    ? { ticketId: proposal.targetId, ...base }
    : { userId: proposal.targetId, ...base };
}

export async function handleActionConfirmation(
  request: Request,
  env: Env,
  proposalId: string,
): Promise<Response> {
  const body = ActionConfirmationRequestSchema.parse(
    await readJsonBody(request),
  );
  const proposals = new WriteProposalRepository(env.DB);
  const proposal = await proposals.get(proposalId);
  if (!proposal) {
    return errorResponse(
      404,
      "validation_error",
      "Write proposal was not found.",
      false,
    );
  }
  const conversations = new ConversationRepository(env.DB);
  const conversation = await conversations.get(
    tenant(request),
    proposal.conversationId,
  );
  if (!conversation) {
    return errorResponse(
      404,
      "validation_error",
      "Write proposal was not found.",
      false,
    );
  }

  if (proposal.conversationId !== conversation.id) {
    return errorResponse(
      404,
      "validation_error",
      "Write proposal was not found.",
      false,
    );
  }

  const pendingRepository = new PendingTurnRepository(env.DB);
  const pending = await pendingRepository.get(proposalId);
  if (!pending || pending.conversationId !== conversation.id) {
    return errorResponse(
      404,
      "validation_error",
      "The pending write turn was not found.",
      false,
    );
  }
  const state = parsePendingTurnState(pending.state);
  const assistant = state.messages.at(-1)?.content;
  const toolUse = Array.isArray(assistant)
    ? assistant.find(
        (block) =>
          block.type === "tool_use" &&
          block.name === proposal.action &&
          state.outstandingToolUseIds.includes(block.id),
      )
    : undefined;
  if (!toolUse || toolUse.type !== "tool_use") {
    return errorResponse(
      409,
      "validation_error",
      "The pending write turn does not match this proposal.",
      false,
    );
  }

  const confirmed = await proposals.confirm({
    id: proposalId,
    capability: body.capability,
    recordVersion: body.recordVersion,
  });
  if ("error" in confirmed) return confirmationError(confirmed);
  const refreshed = await pendingRepository.updateState(proposalId, {
    ...state,
    deadlineAt: Date.now() + TURN_LIMITS.timeoutMs,
  });
  if (!refreshed) {
    return errorResponse(
      409,
      "validation_error",
      "The pending write turn is no longer available.",
      false,
    );
  }

  return Response.json(
    ActionConfirmationResponseSchema.parse({
      kind: "delegated_tool_request",
      turnId: proposalId,
      requests: [
        {
          toolUseId: toolUse.id,
          toolName: confirmed.action,
          input: delegatedInput(confirmed),
        },
      ],
    }),
  );
}
