import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { ConversationRepository } from "./conversations";

const NOW = new Date("2026-07-18T12:00:00.000Z");

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pending_turns"),
    env.DB.prepare("DELETE FROM tool_runs"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM conversations"),
  ]);
});

describe("ConversationRepository", () => {
  it("creates a conversation with a 90-day expiry", async () => {
    const repository = new ConversationRepository(env.DB, () => NOW);

    const conversation = await repository.create("tenant-a", 8421);

    expect(conversation.id).toMatch(/^conv_/);
    expect(conversation.createdAt).toBe("2026-07-18T12:00:00.000Z");
    expect(conversation.expiresAt).toBe("2026-10-16T12:00:00.000Z");
  });

  it("isolates ticket history by tenant", async () => {
    const repository = new ConversationRepository(env.DB, () => NOW);
    await repository.create("tenant-a", 8421);
    await repository.create("tenant-b", 8421);

    const conversations = await repository.listForTicket("tenant-a", 8421);

    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.tenantKey).toBe("tenant-a");
  });

  it("orders messages by creation time", async () => {
    let tick = 0;
    const repository = new ConversationRepository(
      env.DB,
      () => new Date(NOW.getTime() + tick++ * 1_000),
    );
    const conversation = await repository.create("tenant-a", 8421);
    await repository.appendMessage(conversation.id, {
      role: "assistant",
      content: "Second",
    });
    await repository.appendMessage(conversation.id, {
      role: "user",
      content: "Third",
      agent: { id: 9, name: "Agent" },
    });

    const messages = await repository.listMessages("tenant-a", conversation.id);

    expect(messages.map((message) => message.content)).toEqual([
      "Second",
      "Third",
    ]);
    expect(messages[1]?.agentName).toBe("Agent");
  });

  it("stores compact tool summaries", async () => {
    const repository = new ConversationRepository(env.DB, () => NOW);
    const conversation = await repository.create("tenant-a", 8421);

    const run = await repository.appendToolRun(conversation.id, {
      skillId: "woocommerce",
      toolName: "woocommerce_get_order",
      requestSummary: { orderId: "10982" },
    });
    await repository.completeToolRun(run.id, {
      status: "succeeded",
      resultSummary: { status: "processing" },
    });

    await expect(
      repository.listToolRuns("tenant-a", conversation.id),
    ).resolves.toMatchObject([
      {
        skillId: "woocommerce",
        status: "succeeded",
        requestSummary: { orderId: "10982" },
        resultSummary: { status: "processing" },
      },
    ]);
  });

  it("round-trips assistant citations and tool activity", async () => {
    const repository = new ConversationRepository(env.DB, () => NOW);
    const conversation = await repository.create("tenant-a", 8421);
    await repository.appendMessage(conversation.id, {
      role: "assistant",
      content: "Order 10982 is processing.",
      citations: [
        {
          provider: "woocommerce",
          label: "WooCommerce order 10982",
          providerId: "10982",
          url: "https://store.example/orders/10982",
        },
      ],
      toolEvents: [
        {
          skillId: "woocommerce",
          toolName: "woocommerce_get_order",
          status: "succeeded",
          summary: "WooCommerce lookup completed.",
        },
      ],
    });

    await expect(
      repository.listMessages("tenant-a", conversation.id),
    ).resolves.toMatchObject([
      {
        citations: [{ providerId: "10982" }],
        toolEvents: [{ toolName: "woocommerce_get_order" }],
      },
    ]);
  });

  it("deletes expired conversations and their children", async () => {
    const repository = new ConversationRepository(env.DB, () => NOW);
    const conversation = await repository.create("tenant-a", 8421);
    await repository.appendMessage(conversation.id, {
      role: "user",
      content: "Old message",
    });

    const deleted = await repository.deleteExpired(
      new Date("2026-10-17T12:00:00.000Z"),
    );

    expect(deleted).toBe(1);
    await expect(repository.listForTicket("tenant-a", 8421)).resolves.toEqual(
      [],
    );
  });
});
