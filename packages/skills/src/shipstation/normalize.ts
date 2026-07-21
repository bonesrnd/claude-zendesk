import {
  NormalizedCustomerSchema,
  NormalizedOrderSchema,
  NormalizedShipmentSchema,
  type NormalizedCustomer,
  type NormalizedOrder,
  type NormalizedShipment,
} from "@resolve/contracts";

import type {
  ShipStationV1Customer,
  ShipStationV1Order,
  ShipStationV1Shipment,
  ShipStationV2Shipment,
} from "./schemas";

function dashboardUrl(
  path: "customers" | "orders" | "shipments",
  searchValue: string,
): string {
  const url = new URL(`https://ship.shipstation.com/${path}`);
  url.searchParams.set("quickSearch", searchValue);
  return url.toString();
}

function isoDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .replace(/(\.\d{3})\d+/, "$1")
    .replace(/(?<!Z|[+-]\d{2}:\d{2})$/, "Z");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function shippingMethod(
  carrier: string | null | undefined,
  service: string | null | undefined,
): string | undefined {
  const parts = [carrier, service].filter((value): value is string =>
    Boolean(value),
  );
  return parts.length > 0 ? parts.join(" / ") : undefined;
}

export function normalizeV2Shipment(shipment: ShipStationV2Shipment): {
  order: NormalizedOrder;
  shipment: NormalizedShipment;
} {
  const orderNumber =
    shipment.shipment_number ??
    shipment.external_order_id ??
    shipment.external_shipment_id ??
    shipment.shipment_id;
  const sourceUrl = dashboardUrl("shipments", shipment.shipment_id);
  const created = isoDate(shipment.created_at);
  const shipped = isoDate(shipment.ship_date);
  const lineItems = shipment.packages
    .flatMap((pkg) => pkg.products)
    .slice(0, 200)
    .map((product) => ({
      name: product.name,
      quantity: product.quantity,
      ...(product.sku ? { sku: product.sku } : {}),
    }));

  return {
    order: NormalizedOrderSchema.parse({
      provider: "shipstation",
      providerId: shipment.shipment_id,
      orderNumber,
      status: shipment.shipment_status,
      ...(created ? { createdAt: created } : {}),
      ...(shippingMethod(shipment.carrier_id, shipment.service_code)
        ? {
            shippingMethod: shippingMethod(
              shipment.carrier_id,
              shipment.service_code,
            ),
          }
        : {}),
      ...(shipment.tracking_number
        ? { trackingNumber: shipment.tracking_number }
        : {}),
      sourceUrl,
      lineItems,
      metadata: [
        ...(shipment.external_order_id
          ? [
              {
                key: "external_order_id",
                value: shipment.external_order_id,
              },
            ]
          : []),
      ],
    }),
    shipment: NormalizedShipmentSchema.parse({
      provider: "shipstation",
      providerId: shipment.shipment_id,
      orderNumber,
      status: shipment.shipment_status,
      ...(shipment.carrier_id ? { carrier: shipment.carrier_id } : {}),
      ...(shipment.service_code ? { service: shipment.service_code } : {}),
      ...(shipment.tracking_number
        ? { trackingNumber: shipment.tracking_number }
        : {}),
      ...(shipped ? { shipDate: shipped } : {}),
      sourceUrl,
    }),
  };
}

export function recipientFromV2Shipment(
  shipment: ShipStationV2Shipment,
): NormalizedCustomer | undefined {
  const recipient = shipment.ship_to;
  if (!recipient) return undefined;
  return NormalizedCustomerSchema.parse({
    provider: "shipstation",
    providerId: shipment.shipment_id,
    name: recipient.name || recipient.email || "Shipment recipient",
    ...(recipient.email ? { email: recipient.email } : {}),
    ...(recipient.phone ? { phone: recipient.phone } : {}),
    sourceUrl: dashboardUrl("shipments", shipment.shipment_id),
  });
}

export function normalizeV1Customer(
  customer: ShipStationV1Customer,
): NormalizedCustomer {
  return NormalizedCustomerSchema.parse({
    provider: "shipstation",
    providerId: String(customer.customerId),
    name:
      customer.name ||
      customer.email ||
      `ShipStation customer ${customer.customerId}`,
    ...(customer.email ? { email: customer.email } : {}),
    ...(customer.phone ? { phone: customer.phone } : {}),
    sourceUrl: dashboardUrl("customers", String(customer.customerId)),
  });
}

export function normalizeV1Order(order: ShipStationV1Order): NormalizedOrder {
  const date = isoDate(order.orderDate);
  const method = shippingMethod(order.carrierCode, order.serviceCode);
  return NormalizedOrderSchema.parse({
    provider: "shipstation",
    providerId: String(order.orderId),
    orderNumber: order.orderNumber,
    status: order.orderStatus,
    ...(date ? { createdAt: date } : {}),
    ...(order.amountPaid === undefined
      ? {}
      : { total: String(order.amountPaid) }),
    ...(method ? { shippingMethod: method } : {}),
    sourceUrl: dashboardUrl("orders", order.orderNumber),
    lineItems: order.items.slice(0, 200).map((item) => ({
      name: item.name,
      quantity: item.quantity,
      ...(item.sku ? { sku: item.sku } : {}),
    })),
    metadata: order.tagIds.map((tagId) => ({
      key: "tag_id",
      value: tagId,
    })),
  });
}

export function recipientFromV1Order(
  order: ShipStationV1Order,
): NormalizedCustomer | undefined {
  if (!order.shipTo && !order.customerEmail) return undefined;
  return NormalizedCustomerSchema.parse({
    provider: "shipstation",
    providerId: String(order.orderId),
    name:
      order.shipTo?.name ||
      order.customerEmail ||
      `Order ${order.orderNumber} recipient`,
    ...(order.customerEmail ? { email: order.customerEmail } : {}),
    ...(order.shipTo?.phone ? { phone: order.shipTo.phone } : {}),
    sourceUrl: dashboardUrl("orders", order.orderNumber),
  });
}

export function normalizeV1Shipment(
  shipment: ShipStationV1Shipment,
): NormalizedShipment {
  const date = isoDate(shipment.shipDate ?? shipment.createDate);
  return NormalizedShipmentSchema.parse({
    provider: "shipstation",
    providerId: String(shipment.shipmentId),
    ...(shipment.orderNumber ? { orderNumber: shipment.orderNumber } : {}),
    status: shipment.shipmentStatus,
    ...(shipment.carrierCode ? { carrier: shipment.carrierCode } : {}),
    ...(shipment.serviceCode ? { service: shipment.serviceCode } : {}),
    ...(shipment.trackingNumber
      ? { trackingNumber: shipment.trackingNumber }
      : {}),
    ...(date ? { shipDate: date } : {}),
    sourceUrl: dashboardUrl(
      "shipments",
      shipment.orderNumber ?? String(shipment.shipmentId),
    ),
  });
}
