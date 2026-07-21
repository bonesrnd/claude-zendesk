import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { ConversationRepository } from "./conversations";
import { WriteProposalRepository } from "./write-proposals";

const NOW = new Date("2026-07-21T12:00:00.000Z");

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM write_proposals"),
    env.DB.prepare("DELETE FROM conversations"),
  ]);
});

describe("WriteProposalRepository", () => {
  it("persists a ten-minute pending proposal", async () => {
    const conversation = await new ConversationRepository(
      env.DB,
      () => NOW,
    ).create("tenant-a", 8421);
    const repository = new WriteProposalRepository(env.DB, () => NOW);

    const created = await repository.save("turn_1", conversation.id, 9, {
      action: "zendesk_update_ticket_custom_fields",
      targetId: 8421,
      before: { "123": "pending" },
      changes: { "123": "approved" },
      recordVersion: "2026-07-21T11:59:00.000Z",
    });

    expect(created.capability).toMatch(/^confirm_[0-9a-f]{64}$/);
    expect(created.proposal).toMatchObject({
      id: "turn_1",
      conversationId: conversation.id,
      agentId: 9,
      status: "pending",
      expiresAt: "2026-07-21T12:10:00.000Z",
    });
    await expect(repository.get("turn_1")).resolves.toEqual(created.proposal);
    const row = await env.DB.prepare(
      "SELECT capability_hash FROM write_proposals WHERE id = ?",
    )
      .bind("turn_1")
      .first<{ capability_hash: string }>();
    expect(row?.capability_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.capability_hash).not.toContain(created.capability);
    const second = await repository.save("turn_2", conversation.id, 9, {
      action: "zendesk_update_customer_profile",
      targetId: 77,
      before: { notes: "Before" },
      changes: { notes: "After" },
      recordVersion: "version-1",
    });
    expect(second.capability).not.toBe(created.capability);
  });

  it("confirms once for the single-use capability and record version", async () => {
    const conversation = await new ConversationRepository(
      env.DB,
      () => NOW,
    ).create("tenant-a", 8421);
    const repository = new WriteProposalRepository(env.DB, () => NOW);
    const { capability } = await repository.save("turn_1", conversation.id, 9, {
      action: "zendesk_update_customer_profile",
      targetId: 77,
      before: { phone: "+15551230000" },
      changes: { phone: "+15559870000" },
      recordVersion: "version-1",
    });

    await expect(
      repository.confirm({
        id: "turn_1",
        capability,
        recordVersion: "version-1",
      }),
    ).resolves.toMatchObject({ status: "confirmed" });
    await expect(
      repository.confirm({
        id: "turn_1",
        capability,
        recordVersion: "version-1",
      }),
    ).resolves.toEqual({ error: "not_pending" });
  });

  it.each([
    {
      label: "the wrong capability",
      capability: `confirm_${"0".repeat(64)}`,
      recordVersion: "v1",
      error: "invalid_capability",
    },
    {
      label: "a stale record",
      capability: "OWNER",
      recordVersion: "v2",
      error: "stale",
    },
  ])(
    "rejects $label",
    async ({ capability: supplied, recordVersion, error }) => {
      const conversation = await new ConversationRepository(
        env.DB,
        () => NOW,
      ).create("tenant-a", 8421);
      const repository = new WriteProposalRepository(env.DB, () => NOW);
      const { capability } = await repository.save(
        "turn_1",
        conversation.id,
        9,
        {
          action: "zendesk_update_customer_profile",
          targetId: 77,
          before: { notes: "Before" },
          changes: { notes: "After" },
          recordVersion: "v1",
        },
      );

      await expect(
        repository.confirm({
          id: "turn_1",
          capability: supplied === "OWNER" ? capability : supplied,
          recordVersion,
        }),
      ).resolves.toEqual({ error });
    },
  );

  it("rejects an expired proposal", async () => {
    const conversation = await new ConversationRepository(
      env.DB,
      () => NOW,
    ).create("tenant-a", 8421);
    const repository = new WriteProposalRepository(env.DB, () => NOW);
    const { capability } = await repository.save("turn_1", conversation.id, 9, {
      action: "zendesk_update_customer_profile",
      targetId: 77,
      before: { notes: "Before" },
      changes: { notes: "After" },
      recordVersion: "v1",
    });

    const expiredRepository = new WriteProposalRepository(
      env.DB,
      () => new Date("2026-07-21T12:11:00.000Z"),
    );
    await expect(
      expiredRepository.confirm({
        id: "turn_1",
        capability: `confirm_${"0".repeat(64)}`,
        recordVersion: "v1",
      }),
    ).resolves.toEqual({ error: "invalid_capability" });
    await expect(
      expiredRepository.confirm({
        id: "turn_1",
        capability,
        recordVersion: "v1",
      }),
    ).resolves.toEqual({ error: "expired" });
  });
});
