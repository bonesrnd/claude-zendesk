import { SkillRegistry } from "@resolve/skill-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import customerFixture from "./fixtures/customer.json";
import orderFixture from "./fixtures/order.json";
import { woocommerceSkill } from "./woocommerce.skill";

afterEach(() => {
  vi.unstubAllGlobals();
});

const context = {
  signal: new AbortController().signal,
  credentials: {
    wooBaseUrl: "https://store.example",
    wooConsumerKey: "ck_test",
    wooConsumerSecret: "cs_test",
  },
  tenantKey: "tenant",
  ticketId: 8421,
};

describe("woocommerceSkill", () => {
  it("declares only read tools", () => {
    expect(
      woocommerceSkill.tools.every(
        (tool) =>
          tool.risk === "read" &&
          tool.execution === "server" &&
          !tool.requiresConfirmation,
      ),
    ).toBe(true);
  });

  it("finds a customer and returns a citation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json([customerFixture])),
    );
    const registry = new SkillRegistry([woocommerceSkill]);

    const output = await registry.executeServerTool(
      "woocommerce_find_customer",
      { email: "maya@example.com" },
      context,
    );

    expect(output).toMatchObject({
      customer: { providerId: "77", email: "maya@example.com" },
      citations: [{ provider: "woocommerce", providerId: "77" }],
    });
  });

  it("finds a customer by WooCommerce customer id", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(customerFixture));
    vi.stubGlobal("fetch", fetchMock);
    const registry = new SkillRegistry([woocommerceSkill]);

    const output = await registry.executeServerTool(
      "woocommerce_find_customer",
      { customerId: 77 },
      context,
    );

    expect(output).toMatchObject({
      customer: { providerId: "77", email: "maya@example.com" },
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://store.example/wp-json/wc/v3/customers/77",
    );
  });

  it("lists a customer's prior orders newest first", async () => {
    const older = {
      ...orderFixture,
      id: 10000,
      number: "10000",
      date_created_gmt: "2026-01-01T12:00:00",
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json([orderFixture, older])),
    );
    const registry = new SkillRegistry([woocommerceSkill]);

    const output = await registry.executeServerTool(
      "woocommerce_list_orders",
      { customerId: 77 },
      context,
    );

    expect(output).toMatchObject({
      orders: [{ orderNumber: "10982" }, { orderNumber: "10000" }],
    });
  });

  it("fails safely when credentials are missing", async () => {
    const registry = new SkillRegistry([woocommerceSkill]);

    await expect(
      registry.executeServerTool(
        "woocommerce_find_customer",
        { email: "maya@example.com" },
        { ...context, credentials: {} },
      ),
    ).rejects.toThrow("WooCommerce is not configured");
  });
});
