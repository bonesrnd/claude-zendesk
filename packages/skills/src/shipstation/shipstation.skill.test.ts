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
    expect(
      shipstationSkill.tools.find(
        (tool) => tool.name === "shipstation_find_customer_by_phone",
      ),
    ).toMatchObject({
      risk: "read",
      execution: "server",
      requiresConfirmation: false,
    });
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

  it("finds a normalized ShipStation customer by phone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          customers: [
            {
              customerId: 77331,
              name: "Maya Chen",
              email: "maya@example.com",
              phone: "(512) 555-0199",
            },
          ],
          page: 1,
          pages: 1,
        }),
      ),
    );
    const registry = new SkillRegistry([shipstationSkill]);

    const output = await registry.executeServerTool(
      "shipstation_find_customer_by_phone",
      { phone: "+1 512-555-0199", countryCode: "+1" },
      {
        ...context,
        credentials: {
          shipstationMode: "auto",
          shipstationV1Key: "v1-key",
          shipstationV1Secret: "v1-secret",
        },
      },
    );

    expect(output).toMatchObject({
      customers: [
        {
          providerId: "77331",
          email: "maya@example.com",
          phone: "(512) 555-0199",
        },
      ],
      orders: [],
      searchedRecords: 1,
      incomplete: false,
      apiVersion: "v1",
    });
    expect(shipstationSkill.instructions).toMatch(/phone lookup/i);
    expect(shipstationSkill.instructions).toMatch(/incomplete/i);
  });

  it("rejects phone input with fewer than seven digits before scanning", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const registry = new SkillRegistry([shipstationSkill]);

    await expect(
      registry.executeServerTool(
        "shipstation_find_customer_by_phone",
        { phone: "-------" },
        {
          ...context,
          credentials: {
            shipstationMode: "auto",
            shipstationV1Key: "v1-key",
            shipstationV1Secret: "v1-secret",
          },
        },
      ),
    ).rejects.toThrow("Phone number must contain at least seven digits");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
