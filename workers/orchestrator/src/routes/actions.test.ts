import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import type { PendingTurnState } from "../orchestration/run-turn";
import { ConversationRepository } from "../repositories/conversations";
import { PendingTurnRepository } from "../repositories/pending-turns";
import { WriteProposalRepository } from "../repositories/write-proposals";

const NOW = new Date("2099-07-21T12:00:00.000Z");

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM write_proposals"),
    env.DB.prepare("DELETE FROM pending_turns"),
    env.DB.prepare("DELETE FROM conversations"),
  ]);
});

function request(id: string, body: unknown) {
  return exports.default.fetch(
    new Request(`https://worker.test/v1/actions/${id}/confirm`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.BACKEND_AUTH_TOKEN}`,
        "content-type": "application/json",
        "x-resolve-tenant": env.TENANT_KEY,
      },
      body: JSON.stringify(body),
    }),
  );
}

async function setupProposal(
  now: () => Date = () => NOW,
): Promise<{ id: string; conversationId: string; capability: string }> {
  const conversation = await new ConversationRepository(
    env.DB,
    () => NOW,
  ).create(env.TENANT_KEY, 8421);
  const state: PendingTurnState = {
    agentId: 9,
    ticket: {
      ticketId: 8421,
      subject: "Where is my order?",
      requester: { id: 77, name: "Maya Chen" },
      brand: { id: 123, name: "Solution Peptides" },
      recentConversation: [],
    },
    messages: [
      { role: "user", content: "Update the phone" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool_write",
            name: "zendesk_update_customer_profile",
            input: {
              userId: 77,
              recordVersion: "version-1",
              before: { phone: "+15551230000" },
              changes: { phone: "+15559870000" },
            },
          },
        ],
      },
    ],
    completedResults: [],
    citations: [],
    toolEvents: [],
    outstandingToolUseIds: ["tool_write"],
    remainingModelCalls: 5,
    deadlineAt: 1,
  };
  const pending = await new PendingTurnRepository(env.DB, now).save(
    conversation.id,
    state,
  );
  const created = await new WriteProposalRepository(env.DB, now).save(
    pending.id,
    conversation.id,
    9,
    {
      action: "zendesk_update_customer_profile",
      targetId: 77,
      before: { phone: "+15551230000" },
      changes: { phone: "+15559870000" },
      recordVersion: "version-1",
    },
  );
  return {
    id: pending.id,
    conversationId: conversation.id,
    capability: created.capability,
  };
}

describe("POST /v1/actions/:id/confirm", () => {
  it("returns the delegated write only for the valid capability", async () => {
    const proposal = await setupProposal();

    const response = await request(proposal.id, {
      capability: proposal.capability,
      recordVersion: "version-1",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      kind: "delegated_tool_request",
      turnId: proposal.id,
      requests: [
        {
          toolUseId: "tool_write",
          toolName: "zendesk_update_customer_profile",
          input: {
            userId: 77,
            recordVersion: "version-1",
            before: { phone: "+15551230000" },
            changes: { phone: "+15559870000" },
          },
        },
      ],
    });
    const refreshed = await new PendingTurnRepository(env.DB).get(proposal.id);
    expect(
      (refreshed?.state as { deadlineAt: number }).deadlineAt,
    ).toBeGreaterThan(Date.now());
  });

  it("rejects stale records before returning a delegated write", async () => {
    const proposal = await setupProposal();

    const response = await request(proposal.id, {
      capability: proposal.capability,
      recordVersion: "version-2",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      kind: "error",
      code: "validation_error",
      retryable: false,
    });
    const stored = await new WriteProposalRepository(env.DB).get(proposal.id);
    expect(stored?.status).toBe("pending");
  });

  it("rejects missing, wrong, and reused capabilities", async () => {
    const proposal = await setupProposal();
    const body = {
      capability: proposal.capability,
      recordVersion: "version-1",
    };

    const missing = await request(proposal.id, {
      recordVersion: "version-1",
    });
    expect(missing.status).toBe(400);

    const wrong = await request(proposal.id, {
      ...body,
      capability: `confirm_${"0".repeat(64)}`,
    });
    expect(wrong.status).toBe(404);

    const wrongId = await request("turn_missing", body);
    expect(wrongId.status).toBe(404);

    const callerAgent = await request(proposal.id, { ...body, agentId: 10 });
    expect(callerAgent.status).toBe(400);

    expect((await request(proposal.id, body)).status).toBe(200);
    const repeated = await request(proposal.id, body);
    expect(repeated.status).toBe(409);
  });

  it("rejects an expired proposal", async () => {
    const proposal = await setupProposal();
    await env.DB.prepare(
      "UPDATE write_proposals SET expires_at = ? WHERE id = ?",
    )
      .bind("2000-01-01T00:00:00.000Z", proposal.id)
      .run();

    const response = await request(proposal.id, {
      capability: proposal.capability,
      recordVersion: "version-1",
    });

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({
      kind: "error",
      code: "validation_error",
    });
  });
});
