import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { ConversationRepository } from "./conversations";
import { PendingTurnRepository } from "./pending-turns";

const NOW = new Date("2026-07-18T12:00:00.000Z");

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pending_turns"),
    env.DB.prepare("DELETE FROM conversations"),
  ]);
});

describe("PendingTurnRepository", () => {
  it("consumes a pending turn exactly once", async () => {
    const conversations = new ConversationRepository(env.DB, () => NOW);
    const pending = new PendingTurnRepository(env.DB, () => NOW);
    const conversation = await conversations.create("tenant-a", 8421);
    const saved = await pending.save(conversation.id, {
      messages: [{ role: "user", content: "Find prior tickets" }],
    });

    await expect(pending.consume(saved.id)).resolves.toEqual({
      id: saved.id,
      conversationId: conversation.id,
      state: {
        messages: [{ role: "user", content: "Find prior tickets" }],
      },
      createdAt: "2026-07-18T12:00:00.000Z",
      expiresAt: "2026-07-18T12:10:00.000Z",
    });
    await expect(pending.consume(saved.id)).resolves.toBeUndefined();
  });

  it("removes expired pending state without deleting its conversation", async () => {
    const conversations = new ConversationRepository(env.DB, () => NOW);
    const pending = new PendingTurnRepository(env.DB, () => NOW);
    const conversation = await conversations.create("tenant-a", 8421);
    await pending.save(conversation.id, { messages: [] });

    const deleted = await pending.deleteExpired(
      new Date("2026-07-18T12:11:00.000Z"),
    );

    expect(deleted).toBe(1);
    await expect(
      conversations.listForTicket("tenant-a", 8421),
    ).resolves.toHaveLength(1);
  });
});
