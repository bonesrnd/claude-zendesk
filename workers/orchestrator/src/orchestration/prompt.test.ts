import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "./prompt";

describe("buildSystemPrompt", () => {
  it("bounds ticket conversation data while retaining the newest entries", () => {
    const prompt = buildSystemPrompt(
      {
        ticketId: 8421,
        subject: "Large ticket",
        requester: { id: 77, name: "Maya Chen" },
        brand: { id: 123, name: "Solution Peptides" },
        recentConversation: Array.from({ length: 30 }, (_, index) => ({
          authorName: "Customer",
          body: `${index}:${"x".repeat(19_990)}`,
          createdAt: "2026-07-18T12:00:00.000Z",
          public: true,
        })),
      },
      [],
    );

    expect(prompt.length).toBeLessThan(70_000);
    expect(prompt).toContain(
      "You are Słones, a read-only customer-service research assistant.",
    );
    expect(prompt).toContain('"body":"29:');
    expect(prompt).not.toContain('"body":"0:');
  });
});
