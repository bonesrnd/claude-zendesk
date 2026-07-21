import { describe, expect, it } from "vitest";

import {
  ActionConfirmationRequiredResponseSchema,
  ActionConfirmationRequestSchema,
  ActionConfirmationResponseSchema,
  WriteProposalDraftSchema,
  WriteProposalSchema,
} from "./actions";

const proposal = {
  id: "turn_1",
  action: "zendesk_update_ticket_custom_fields",
  targetId: 8421,
  before: { "123": "pending" },
  changes: { "123": "approved" },
  expiresAt: "2026-07-21T12:10:00.000Z",
} as const;

describe("write action contracts", () => {
  it("accepts a bounded Zendesk write proposal", () => {
    expect(WriteProposalSchema.parse(proposal)).toEqual(proposal);
  });

  it("keeps record versions server-side in proposal drafts", () => {
    expect(
      WriteProposalDraftSchema.parse({
        action: proposal.action,
        targetId: proposal.targetId,
        before: proposal.before,
        changes: proposal.changes,
        recordVersion: "2026-07-21T12:00:00.000Z",
      }),
    ).toEqual({
      action: "zendesk_update_ticket_custom_fields",
      targetId: 8421,
      before: { "123": "pending" },
      changes: { "123": "approved" },
      recordVersion: "2026-07-21T12:00:00.000Z",
    });
  });

  it("requires a capability and the freshly-read record version", () => {
    expect(
      ActionConfirmationRequestSchema.parse({
        capability: `confirm_${"a".repeat(64)}`,
        recordVersion: "2026-07-21T12:00:00.000Z",
      }),
    ).toEqual({
      capability: `confirm_${"a".repeat(64)}`,
      recordVersion: "2026-07-21T12:00:00.000Z",
    });
  });

  it("returns the capability only beside the public proposal", () => {
    const response = ActionConfirmationRequiredResponseSchema.parse({
      kind: "action_confirmation_required",
      conversationId: "conv_1",
      proposal,
      capability: `confirm_${"b".repeat(64)}`,
    });

    expect(response.capability).toBe(`confirm_${"b".repeat(64)}`);
    expect(response.proposal).not.toHaveProperty("capability");
    expect(
      ActionConfirmationRequiredResponseSchema.safeParse({
        kind: "action_confirmation_required",
        conversationId: "conv_1",
        proposal,
      }).success,
    ).toBe(false);
  });

  it("returns only a delegated write after confirmation", () => {
    expect(
      ActionConfirmationResponseSchema.parse({
        kind: "delegated_tool_request",
        turnId: "turn_1",
        requests: [
          {
            toolUseId: "tool_write",
            toolName: "zendesk_update_ticket_custom_fields",
            input: {
              ticketId: 8421,
              recordVersion: "2026-07-21T12:00:00.000Z",
              before: { "123": "pending" },
              changes: { "123": "approved" },
            },
          },
        ],
      }),
    ).toMatchObject({
      kind: "delegated_tool_request",
      turnId: "turn_1",
    });
  });
});
