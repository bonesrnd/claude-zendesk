import { describe, expect, it } from "vitest";

import v1OrderFixture from "./fixtures/v1-order.json";
import v2ShipmentFixture from "./fixtures/v2-shipment.json";
import {
  normalizeV1Order,
  normalizeV2Shipment,
  recipientFromV2Shipment,
} from "./normalize";
import {
  ShipStationV1OrderSchema,
  ShipStationV2ShipmentSchema,
} from "./schemas";

describe("ShipStation normalization", () => {
  it("maps v2 shipments into stable shipment and order records", () => {
    const normalized = normalizeV2Shipment(
      ShipStationV2ShipmentSchema.parse(v2ShipmentFixture),
    );

    expect(normalized.shipment).toMatchObject({
      provider: "shipstation",
      providerId: "se-28529731",
      orderNumber: "10982",
      status: "label_purchased",
      carrier: "se-123456",
      service: "ups_ground",
      trackingNumber: "1Z999AA10123456784",
    });
    expect(normalized.order).toMatchObject({
      provider: "shipstation",
      providerId: "se-28529731",
      orderNumber: "10982",
      status: "label_purchased",
      lineItems: [{ name: "Canvas Tote", quantity: 2, sku: "TOTE-NAT" }],
    });
    expect(new URL(normalized.order.sourceUrl).host).toBe(
      "ship.shipstation.com",
    );
    expect(new URL(normalized.shipment.sourceUrl).host).toBe(
      "ship.shipstation.com",
    );
  });

  it("maps v1 orders into the same order shape", () => {
    const normalized = normalizeV1Order(
      ShipStationV1OrderSchema.parse(v1OrderFixture),
    );
    expect(normalized).toMatchObject({
      provider: "shipstation",
      providerId: "445566",
      orderNumber: "10982",
      status: "awaiting_shipment",
      total: "64",
      shippingMethod: "ups / ups_ground",
    });
    expect(new URL(normalized.sourceUrl).host).toBe("ship.shipstation.com");
  });

  it("extracts a customer profile from v2 recipient data", () => {
    expect(
      recipientFromV2Shipment(
        ShipStationV2ShipmentSchema.parse(v2ShipmentFixture),
      ),
    ).toMatchObject({
      provider: "shipstation",
      providerId: "se-28529731",
      name: "Maya Chen",
      email: "maya@example.com",
    });
  });

  it("rejects invalid shipment identifiers", () => {
    expect(
      ShipStationV2ShipmentSchema.safeParse({
        ...v2ShipmentFixture,
        shipment_id: "",
      }).success,
    ).toBe(false);
  });
});
