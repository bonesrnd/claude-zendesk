import { afterEach, describe, expect, it, vi } from "vitest";

import v1OrderFixture from "./fixtures/v1-order.json";
import v2ShipmentFixture from "./fixtures/v2-shipment.json";
import {
  createShipStationClient,
  createShipStationPhoneClient,
  ShipStationHttpError,
  ShipStationV1Client,
  ShipStationV2Client,
} from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
});

const signal = new AbortController().signal;
const v1Customer = {
  customerId: 77331,
  name: "Maya Chen",
  email: "maya@example.com",
  phone: "(512) 555-0199",
};

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

  it("scans v1 customers with pageSize 500 and stops on a phone match", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          customers: [{ ...v1Customer, customerId: 1, phone: "5125550100" }],
          page: 1,
          pages: 3,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          customers: [v1Customer],
          page: 2,
          pages: 3,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ShipStationV1Client("v1-key", "v1-secret", signal);

    const result = await client.findCustomerByPhone({
      phone: "+1 512-555-0199 ext. 4",
    });

    expect(result).toMatchObject({
      customers: [
        {
          provider: "shipstation",
          providerId: "77331",
          phone: "(512) 555-0199",
        },
      ],
      orders: [],
      searchedRecords: 2,
      incomplete: true,
      apiVersion: "v1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://ssapi.shipstation.com/customers?pageSize=500&page=1",
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("page=2");
  });

  it("rejects invalid phone input before either API scans", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const clients = [
      new ShipStationV1Client("v1-key", "v1-secret", signal),
      new ShipStationV2Client("v2-key", signal),
    ];

    for (const client of clients) {
      await expect(
        client.findCustomerByPhone({ phone: "-------" }),
      ).rejects.toThrow("Phone number must contain at least seven digits");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps v1 customer scans at ten pages and marks remaining pages incomplete", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) => {
        const page = Number(new URL(String(input)).searchParams.get("page"));
        return Response.json({
          customers: [
            {
              ...v1Customer,
              customerId: page,
              phone: `512555${String(page).padStart(4, "0")}`,
            },
          ],
          page,
          pages: 11,
        });
      });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ShipStationV1Client("v1-key", "v1-secret", signal);

    const result = await client.findCustomerByPhone({ phone: "5125559999" });

    expect(result).toMatchObject({
      customers: [],
      orders: [],
      searchedRecords: 10,
      incomplete: true,
      apiVersion: "v1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("marks a v1 match on the final allowed page incomplete when pages remain", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) => {
        const page = Number(new URL(String(input)).searchParams.get("page"));
        return Response.json({
          customers: [
            page === 10
              ? v1Customer
              : {
                  ...v1Customer,
                  customerId: page,
                  phone: `555010${page}`,
                },
          ],
          page,
          pages: 11,
        });
      });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ShipStationV1Client("v1-key", "v1-secret", signal);

    const result = await client.findCustomerByPhone({ phone: "5125550199" });

    expect(result).toMatchObject({
      customers: [{ providerId: "77331" }],
      searchedRecords: 10,
      incomplete: true,
      apiVersion: "v1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("falls back to v2 phone scanning when v1 credentials are absent", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        shipments: [v2ShipmentFixture],
        total: 1,
        pages: 1,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createShipStationPhoneClient(
      {
        shipstationMode: "auto",
        shipstationV2Key: "v2-key",
      },
      signal,
    );

    const result = await client.findCustomerByPhone({
      phone: "+1-555-0100",
    });

    expect(result).toMatchObject({
      customers: [{ email: "maya@example.com" }],
      orders: [{ orderNumber: "10982" }],
      searchedRecords: 1,
      incomplete: false,
      apiVersion: "v2",
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v2/shipments");
  });

  it("marks an early v2 phone match incomplete when more pages remain", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        shipments: [v2ShipmentFixture],
        total: 2,
        pages: 2,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ShipStationV2Client("v2-key", signal);

    const result = await client.findCustomerByPhone({
      phone: v2ShipmentFixture.ship_to.phone,
    });

    expect(result).toMatchObject({
      customers: [{ email: "maya@example.com" }],
      orders: [{ orderNumber: "10982" }],
      searchedRecords: 1,
      incomplete: true,
      apiVersion: "v2",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caps v2 phone scans at five pages and marks remaining pages incomplete", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) => {
        const page =
          Number(new URL(String(input)).searchParams.get("page")) || 1;
        return Response.json({
          shipments: [
            {
              ...v2ShipmentFixture,
              shipment_id: `se-page-${page}`,
              ship_to: {
                ...v2ShipmentFixture.ship_to,
                phone: `555010${page}`,
              },
            },
          ],
          total: 6,
          pages: 6,
        });
      });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ShipStationV2Client("v2-key", signal);

    const result = await client.findCustomerByPhone({ phone: "5125550199" });

    expect(result).toMatchObject({
      customers: [],
      orders: [],
      searchedRecords: 5,
      incomplete: true,
      apiVersion: "v2",
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(String(fetchMock.mock.calls[4]?.[0])).toContain("page=5");
  });

  it("marks a v2 match on the final allowed page incomplete when pages remain", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) => {
        const page =
          Number(new URL(String(input)).searchParams.get("page")) || 1;
        return Response.json({
          shipments: [
            {
              ...v2ShipmentFixture,
              shipment_id: `se-page-${page}`,
              ship_to: {
                ...v2ShipmentFixture.ship_to,
                phone:
                  page === 5
                    ? v2ShipmentFixture.ship_to.phone
                    : `555010${page}`,
              },
            },
          ],
          total: 6,
          pages: 6,
        });
      });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ShipStationV2Client("v2-key", signal);

    const result = await client.findCustomerByPhone({
      phone: v2ShipmentFixture.ship_to.phone,
    });

    expect(result).toMatchObject({
      customers: [{ email: "maya@example.com" }],
      orders: [{ orderNumber: "10982" }],
      searchedRecords: 5,
      incomplete: true,
      apiVersion: "v2",
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
