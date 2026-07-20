import { afterEach, describe, expect, it, vi } from "vitest";

import v1OrderFixture from "./fixtures/v1-order.json";
import v2ShipmentFixture from "./fixtures/v2-shipment.json";
import {
  createShipStationClient,
  ShipStationHttpError,
  ShipStationV1Client,
  ShipStationV2Client,
} from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
});

const signal = new AbortController().signal;

describe("ShipStation clients", () => {
  it("uses the api-key header for v2", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ shipments: [v2ShipmentFixture], total: 1, pages: 1 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ShipStationV2Client("v2-key", signal);

    await client.findOrders({ orderNumber: "10982" });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://api.shipstation.com/v2/shipments?shipment_number=10982&page_size=20&sort_by=created_at&sort_dir=desc",
    );
    expect(new Headers(init?.headers).get("api-key")).toBe("v2-key");
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
  });

  it("uses Basic authentication for v1", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        orders: [v1OrderFixture],
        total: 1,
        page: 1,
        pages: 1,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ShipStationV1Client("v1-key", "v1-secret", signal);

    await client.findOrders({ orderNumber: "10982" });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://ssapi.shipstation.com/orders?orderNumber=10982&pageSize=20&page=1",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Basic ${btoa("v1-key:v1-secret")}`,
    );
    expect(new Headers(init?.headers).get("api-key")).toBeNull();
  });

  it("prefers configured v2 credentials in auto mode", () => {
    expect(
      createShipStationClient(
        {
          shipstationMode: "auto",
          shipstationV2Key: "v2-key",
          shipstationV1Key: "v1-key",
          shipstationV1Secret: "v1-secret",
        },
        signal,
      ),
    ).toBeInstanceOf(ShipStationV2Client);
  });

  it("does not fall back after a v2 authentication failure", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("invalid key", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createShipStationClient(
      {
        shipstationMode: "auto",
        shipstationV2Key: "v2-key",
        shipstationV1Key: "v1-key",
        shipstationV1Secret: "v1-secret",
      },
      signal,
    );

    await expect(client.findOrders({ orderNumber: "10982" })).rejects.toEqual(
      expect.objectContaining<Partial<ShipStationHttpError>>({
        status: 401,
        code: "configuration_error",
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("searches bounded v2 pages for customer email matches", async () => {
    const otherShipment = {
      ...v2ShipmentFixture,
      shipment_id: "se-other",
      ship_to: {
        ...v2ShipmentFixture.ship_to,
        email: "other@example.com",
      },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        Response.json({
          shipments: [otherShipment],
          total: 2,
          pages: 2,
        }),
      )
      .mockImplementationOnce(async () =>
        Response.json({
          shipments: [v2ShipmentFixture],
          total: 2,
          pages: 2,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ShipStationV2Client("v2-key", signal);

    const result = await client.findOrders({
      customerEmail: "maya@example.com",
    });

    expect(result.records).toHaveLength(1);
    expect(result.incomplete).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("page=2");
  });

  it("marks capped v2 email scans as incomplete", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        shipments: [],
        total: 200,
        pages: 10,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ShipStationV2Client("v2-key", signal);

    const result = await client.findOrders({
      customerEmail: "missing@example.com",
    });

    expect(result).toEqual({ records: [], incomplete: true });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
