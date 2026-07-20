import { describe, expect, it } from "vitest";

import customerFixture from "./fixtures/customer.json";
import orderFixture from "./fixtures/order.json";
import { normalizeWooCustomer, normalizeWooOrder } from "./normalize";
import { WooCustomerSchema, WooOrderSchema } from "./schemas";

const storeUrl = "https://store.example";

describe("WooCommerce normalization", () => {
  it("maps an order into the shared domain", () => {
    const order = normalizeWooOrder(
      WooOrderSchema.parse(orderFixture),
      storeUrl,
    );

    expect(order).toMatchObject({
      provider: "woocommerce",
      providerId: "10982",
      orderNumber: "10982",
      status: "processing",
      createdAt: "2026-07-17T15:30:00.000Z",
      currency: "USD",
      total: "64.00",
      shippingMethod: "UPS Ground",
      lineItems: [{ name: "Canvas Tote", quantity: 2, sku: "TOTE-NAT" }],
      billingSummary: {
        name: "Maya Chen",
        city: "Boston",
        state: "MA",
        postalCode: "02110",
        country: "US",
        email: "maya@example.com",
        phone: "+1-555-0100",
      },
      shippingSummary: {
        name: "Maya Chen",
        city: "Boston",
        state: "MA",
        postalCode: "02110",
        country: "US",
      },
      refunds: [{ providerId: "501", reason: "Damaged item", total: "-12.00" }],
    });
    expect(order.metadata).toEqual([
      { key: "gift", value: true },
      { key: "warehouse", value: '{"zone":"east"}' },
    ]);
    expect(order.sourceUrl).toBe(
      "https://store.example/wp-admin/post.php?post=10982&action=edit",
    );
  });

  it("maps a customer into the shared domain", () => {
    expect(
      normalizeWooCustomer(WooCustomerSchema.parse(customerFixture), storeUrl),
    ).toEqual({
      provider: "woocommerce",
      providerId: "77",
      name: "Maya Chen",
      email: "maya@example.com",
      phone: "+1-555-0100",
      sourceUrl: "https://store.example/wp-admin/user-edit.php?user_id=77",
    });
  });

  it("rejects invalid provider field types", () => {
    expect(
      WooOrderSchema.safeParse({
        ...orderFixture,
        line_items: [
          {
            ...orderFixture.line_items[0],
            quantity: "two",
          },
        ],
      }).success,
    ).toBe(false);
  });
});
