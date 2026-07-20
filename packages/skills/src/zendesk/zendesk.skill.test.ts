import { describe, expect, it } from "vitest";

import {
  ZendeskGetRequesterTicketsInputSchema,
  ZendeskGetTicketOutputSchema,
  ZendeskSearchSolvedTicketsInputSchema,
} from "./schemas";
import { zendeskSkill } from "./zendesk.skill";

describe("zendeskSkill", () => {
  it("declares delegated read tools without handlers", () => {
    expect(
      zendeskSkill.tools.every(
        (tool) =>
          tool.risk === "read" &&
          tool.execution === "delegated" &&
          !tool.handler &&
          !tool.requiresConfirmation,
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
