import {
  NormalizedCustomerSchema,
  NormalizedOrderSchema,
  type AddressSummary,
  type MetadataEntry,
  type NormalizedCustomer,
  type NormalizedOrder,
} from "@resolve/contracts";

import type { WooAddress, WooCustomer, WooOrder } from "./schemas";

function adminUrl(
  storeUrl: string,
  path: string,
  params: Record<string, string>,
): string {
  const url = new URL(path, storeUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function createdAt(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const withZone = /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function metadataValue(value: unknown): MetadataEntry["value"] {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return (JSON.stringify(value) ?? "null").slice(0, 2_000);
}

function addressSummary(
  address: WooAddress | undefined,
): AddressSummary | undefined {
  if (!address) return undefined;
  const name = [address.first_name, address.last_name]
    .filter(Boolean)
    .join(" ");
  if (
    !name &&
    !address.company &&
    !address.city &&
    !address.email &&
    !address.phone
  ) {
    return undefined;
  }
  return {
    name: name || address.company || "Not provided",
    ...(address.company ? { company: address.company } : {}),
    ...(address.city ? { city: address.city } : {}),
    ...(address.state ? { state: address.state } : {}),
    ...(address.postcode ? { postalCode: address.postcode } : {}),
    ...(address.country ? { country: address.country } : {}),
    ...(address.email ? { email: address.email } : {}),
    ...(address.phone ? { phone: address.phone } : {}),
  };
}

export function normalizeWooOrder(
  order: WooOrder,
  storeUrl: string,
): NormalizedOrder {
  const date = createdAt(order.date_created_gmt);
  const billing = addressSummary(order.billing);
  const shipping = addressSummary(order.shipping);
  return NormalizedOrderSchema.parse({
    provider: "woocommerce",
    providerId: String(order.id),
    orderNumber: order.number,
    status: order.status,
    ...(date ? { createdAt: date } : {}),
    ...(order.currency ? { currency: order.currency } : {}),
    ...(order.total ? { total: order.total } : {}),
    ...(order.shipping_lines[0]?.method_title
      ? { shippingMethod: order.shipping_lines[0].method_title }
      : {}),
    ...(billing ? { billingSummary: billing } : {}),
    ...(shipping ? { shippingSummary: shipping } : {}),
    refunds: order.refunds.map((refund) => ({
      providerId: String(refund.id),
      ...(refund.reason ? { reason: refund.reason } : {}),
      total: refund.total,
    })),
    sourceUrl: adminUrl(storeUrl, "/wp-admin/post.php", {
      post: String(order.id),
      action: "edit",
    }),
    lineItems: order.line_items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      ...(item.sku ? { sku: item.sku } : {}),
    })),
    metadata: order.meta_data.slice(0, 200).map((entry) => ({
      key: entry.key,
      value: metadataValue(entry.value),
    })),
  });
}

export function normalizeWooCustomer(
  customer: WooCustomer,
  storeUrl: string,
): NormalizedCustomer {
  const name =
    [customer.first_name, customer.last_name].filter(Boolean).join(" ") ||
    customer.email ||
    `Customer ${customer.id}`;
  return NormalizedCustomerSchema.parse({
    provider: "woocommerce",
    providerId: String(customer.id),
    name,
    ...(customer.email ? { email: customer.email } : {}),
    ...(customer.billing?.phone ? { phone: customer.billing.phone } : {}),
    sourceUrl: adminUrl(storeUrl, "/wp-admin/user-edit.php", {
      user_id: String(customer.id),
    }),
  });
}
