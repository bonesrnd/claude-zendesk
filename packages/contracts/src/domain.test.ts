import { describe, expect, it } from "vitest";

import { NormalizedOrderSchema, TicketContextSchema } from "./domain";

describe("NormalizedOrderSchema", () => {
  it("requires a source citation target", () => {
    const result = NormalizedOrderSchema.safeParse({
      provider: "woocommerce",
      providerId: "10982",
      orderNumber: "10982",
      status: "processing",
      currency: "USD",
      total: "64.00",
      sourceUrl: "",
      lineItems: [],
      metadata: [],
    });

    expect(result.success).toBe(false);
  });

  it("rejects nested unknown keys", () => {
    const result = NormalizedOrderSchema.safeParse({
      provider: "woocommerce",
      providerId: "10982",
      orderNumber: "10982",
      status: "processing",
      sourceUrl: "https://store.example/wp-admin/post.php?post=10982",
      lineItems: [{ name: "Widget", quantity: 1, hidden: "no" }],
      metadata: [],
    });

    expect(result.success).toBe(false);
  });
});

describe("TicketContextSchema", () => {
  it("limits the number of conversation entries", () => {
    const result = TicketContextSchema.safeParse({
      ticketId: 8421,
      subject: "Where is my order?",
      requester: { id: 77, name: "Maya Chen" },
      recentConversation: Array.from({ length: 31 }, (_, index) => ({
        authorName: "Agent",
        body: `Message ${index}`,
        createdAt: "2026-07-18T12:00:00.000Z",
        public: true,
      })),
    });

    expect(result.success).toBe(false);
  });
});
