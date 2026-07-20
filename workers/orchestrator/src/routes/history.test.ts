import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { ConversationRepository } from "../repositories/conversations";

function get(path: string, tenant = env.TENANT_KEY) {
  return exports.default.fetch(
    new Request(`https://worker.test${path}`, {
      headers: {
        authorization: `Bearer ${env.BACKEND_AUTH_TOKEN}`,
        "x-resolve-tenant": tenant,
      },
    }),
  );
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM conversations"),
  ]);
});

describe("history routes", () => {
  it("lists only the installation's ticket conversations", async () => {
    const repository = new ConversationRepository(env.DB);
    const visible = await repository.create(env.TENANT_KEY, 8421);
    await repository.create("other-tenant", 8421);

    const response = await get("/v1/tickets/8421/conversations");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      conversations: [{ id: visible.id, ticketId: 8421 }],
    });
  });

  it("loads display messages for one conversation", async () => {
    const repository = new ConversationRepository(env.DB);
    const conversation = await repository.create(env.TENANT_KEY, 8421);
    await repository.appendMessage(conversation.id, {
      role: "user",
      content: "Check the order",
    });

    const response = await get(`/v1/conversations/${conversation.id}/messages`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      messages: [{ role: "user", content: "Check the order" }],
    });
  });

  it("returns not found for another tenant's conversation", async () => {
    const repository = new ConversationRepository(env.DB);
    const conversation = await repository.create("other-tenant", 8421);

    const response = await get(`/v1/conversations/${conversation.id}/messages`);

    expect(response.status).toBe(404);
  });
});
