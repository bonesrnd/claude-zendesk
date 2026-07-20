import { SkillRegistry } from "@resolve/skill-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import v2ShipmentFixture from "./fixtures/v2-shipment.json";
import { shipstationSkill } from "./shipstation.skill";

afterEach(() => {
  vi.unstubAllGlobals();
});

const context = {
  signal: new AbortController().signal,
  credentials: {
    shipstationMode: "v2",
    shipstationV2Key: "v2-key",
  },
  tenantKey: "tenant",
  ticketId: 8421,
};

describe("shipstationSkill", () => {
  it("declares only read tools", () => {
    expect(
      shipstationSkill.tools.every(
        (tool) =>
          tool.risk === "read" &&
          tool.execution === "server" &&
          !tool.requiresConfirmation,
      ),
    ).toBe(true);
  });

  it("finds v2 orders through normalized shipments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          shipments: [v2ShipmentFixture],
          total: 1,
          pages: 1,
        }),
      ),
    );
    const registry = new SkillRegistry([shipstationSkill]);

    const output = await registry.executeServerTool(
      "shipstation_find_orders",
      { orderNumber: "10982" },
      context,
    );

    expect(output).toMatchObject({
      orders: [{ orderNumber: "10982", providerId: "se-28529731" }],
      customers: [{ email: "maya@example.com" }],
      citations: [{ provider: "shipstation", providerId: "se-28529731" }],
      incomplete: false,
    });
  });

  it("gets tracking without inventing events", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(v2ShipmentFixture)),
    );
    const registry = new SkillRegistry([shipstationSkill]);

    const output = await registry.executeServerTool(
      "shipstation_get_tracking",
      { providerId: "se-28529731" },
      context,
    );

    expect(output).toMatchObject({
      shipment: {
        trackingNumber: "1Z999AA10123456784",
        service: "ups_ground",
      },
    });
    expect(output).not.toHaveProperty("events");
  });

  it("supports external id, recipient, and bounded date filters", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ shipments: [], total: 0, pages: 1 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const registry = new SkillRegistry([shipstationSkill]);

    await registry.executeServerTool(
      "shipstation_find_orders",
      {
        externalId: "external-10982",
        recipientName: "Maya Chen",
        createdAtStart: "2026-07-01T00:00:00.000Z",
        createdAtEnd: "2026-07-31T23:59:59.000Z",
      },
      context,
    );

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("external_shipment_id")).toBe("external-10982");
    expect(url.searchParams.get("created_at_start")).toBe(
      "2026-07-01T00:00:00.000Z",
    );
    expect(url.searchParams.get("ship_to_name")).toBe("Maya Chen");
  });

  it("fails safely when the selected API is not configured", async () => {
    const registry = new SkillRegistry([shipstationSkill]);

    await expect(
      registry.executeServerTool(
        "shipstation_find_orders",
        { orderNumber: "10982" },
        { ...context, credentials: { shipstationMode: "v2" } },
      ),
    ).rejects.toThrow("ShipStation v2 is not configured");
  });
});
