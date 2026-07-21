import { describe, expect, it } from "vitest";

import {
  ZendeskGetRequesterTicketsInputSchema,
  ZendeskGetTicketOutputSchema,
  ZendeskSearchSolvedTicketsInputSchema,
  ZendeskUpdateCustomerProfileInputSchema,
  ZendeskUpdateTicketCustomFieldsInputSchema,
} from "./schemas";
import { zendeskSkill } from "./zendesk.skill";

describe("zendeskSkill", () => {
  it("declares confirmed delegated writes without handlers", () => {
    const writes = zendeskSkill.tools.filter((tool) => tool.risk === "write");

    expect(writes.map((tool) => tool.name)).toEqual([
      "zendesk_update_ticket_custom_fields",
      "zendesk_update_customer_profile",
    ]);
    expect(
      writes.every(
        (tool) =>
          tool.execution === "delegated" &&
          tool.requiresConfirmation &&
          !tool.handler &&
          Boolean(tool.createProposal),
      ),
    ).toBe(true);
  });

  it("restricts profile writes to the approved fields", () => {
    const base = {
      userId: 77,
      recordVersion: "2026-07-21T12:00:00.000Z",
      before: { phone: "+15551230000" },
    };

    expect(
      ZendeskUpdateCustomerProfileInputSchema.safeParse({
        ...base,
        changes: {
          name: "Maya Chen",
          phone: "+15559870000",
          notes: "Prefers SMS",
          organization_id: 42,
          user_fields: { customer_tier: "gold" },
        },
      }).success,
    ).toBe(true);
    for (const field of [
      "email",
      "role",
      "password",
      "suspended",
      "external_id",
      "merge_into_id",
    ]) {
      expect(
        ZendeskUpdateCustomerProfileInputSchema.safeParse({
          ...base,
          changes: { [field]: "forbidden" },
        }).success,
      ).toBe(false);
    }
  });

  it("accepts only numeric ticket custom-field identifiers", () => {
    const base = {
      ticketId: 8421,
      recordVersion: "2026-07-21T12:00:00.000Z",
      before: { "123": "pending" },
    };
    expect(
      ZendeskUpdateTicketCustomFieldsInputSchema.safeParse({
        ...base,
        changes: { "123": "approved" },
      }).success,
    ).toBe(true);
    expect(
      ZendeskUpdateTicketCustomFieldsInputSchema.safeParse({
        ...base,
        changes: { status: "closed" },
      }).success,
    ).toBe(false);
  });

  it("declares delegated read tools without handlers", () => {
    const delegated = zendeskSkill.tools.filter(
      (tool) => tool.execution === "delegated" && tool.risk === "read",
    );
    expect(delegated.map((tool) => tool.name)).toContain(
      "zendesk_list_voicemails",
    );
    expect(
      delegated.every(
        (tool) =>
          tool.risk === "read" && !tool.handler && !tool.requiresConfirmation,
      ),
    ).toBe(true);
  });

  it("bounds requester history searches", () => {
    expect(
      ZendeskGetRequesterTicketsInputSchema.safeParse({
        requesterId: 77,
        limit: 21,
      }).success,
    ).toBe(false);
    expect(
      ZendeskGetRequesterTicketsInputSchema.parse({
        requesterId: 77,
      }),
    ).toEqual({ requesterId: 77, limit: 10 });
  });

  it("requires bounded terms for solved-ticket searches", () => {
    expect(
      ZendeskSearchSolvedTicketsInputSchema.safeParse({
        terms: [],
      }).success,
    ).toBe(false);
    expect(
      ZendeskSearchSolvedTicketsInputSchema.safeParse({
        terms: Array.from({ length: 9 }, () => "damaged item"),
      }).success,
    ).toBe(false);
  });

  it("requires a citation on detailed ticket output", () => {
    expect(
      ZendeskGetTicketOutputSchema.safeParse({
        ticket: {
          ticketId: 7314,
          subject: "Damaged item",
          status: "solved",
          createdAt: "2026-01-01T12:00:00.000Z",
          updatedAt: "2026-01-02T12:00:00.000Z",
          snippet: "Replacement sent",
          url: "https://example.zendesk.com/agent/tickets/7314",
          comments: [],
        },
        citations: [],
      }).success,
    ).toBe(false);
  });

  it("allows an empty result without a citation", () => {
    expect(
      ZendeskGetTicketOutputSchema.parse({
        ticket: null,
        citations: [],
      }),
    ).toEqual({ ticket: null, citations: [] });
  });
});
