import {
  CitationSchema,
  NormalizedCustomerSchema,
  NormalizedOrderSchema,
  PhoneSearchResultSchema,
  NormalizedShipmentSchema,
  type Citation,
  type NormalizedCustomer,
  type NormalizedOrder,
  type NormalizedShipment,
} from "@resolve/contracts";
import { defineSkill, defineTool } from "@resolve/skill-sdk";
import { z } from "zod";

import {
  createShipStationClient,
  createShipStationPhoneClient,
  type ShipStationOrderRecord,
  type ShipStationTrackingRecord,
} from "./client";
import {
  normalizeV1Order,
  normalizeV1Shipment,
  normalizeV2Shipment,
  recipientFromV1Order,
  recipientFromV2Shipment,
} from "./normalize";

export { normalizePhone, phonesMatch } from "./phone";

const FindOrdersInput = z
  .strictObject({
    orderNumber: z.string().min(1).max(100).optional(),
    customerEmail: z.email().optional(),
    externalId: z.string().min(1).max(200).optional(),
    recipientName: z.string().min(1).max(200).optional(),
    createdAtStart: z.iso.datetime().optional(),
    createdAtEnd: z.iso.datetime().optional(),
  })
  .refine(
    (input) =>
      input.orderNumber ||
      input.customerEmail ||
      input.externalId ||
      input.recipientName ||
      input.createdAtStart ||
      input.createdAtEnd,
    {
      message:
        "Provide an order, customer, recipient, external id, or date filter",
    },
  );
const FindOrdersOutput = z.strictObject({
  orders: z.array(NormalizedOrderSchema).max(20),
  customers: z.array(NormalizedCustomerSchema).max(20),
  citations: z.array(CitationSchema).max(40),
  incomplete: z.boolean(),
});

const ProviderIdInput = z.strictObject({
  providerId: z.string().min(1).max(200),
});
const GetOrderOutput = z.strictObject({
  order: NormalizedOrderSchema.nullable(),
  shipment: NormalizedShipmentSchema.nullable(),
  customer: NormalizedCustomerSchema.nullable(),
  citations: z.array(CitationSchema).max(3),
});
const GetTrackingOutput = z.strictObject({
  shipment: NormalizedShipmentSchema.nullable(),
  citations: z.array(CitationSchema).max(1),
});
const PhoneSearchOutputSchema = PhoneSearchResultSchema;

function citation(
  record: NormalizedOrder | NormalizedShipment | NormalizedCustomer,
): Citation {
  const label =
    "orderNumber" in record && record.orderNumber
      ? `ShipStation ${record.orderNumber}`
      : `ShipStation record ${record.providerId}`;
  return CitationSchema.parse({
    provider: "shipstation",
    providerId: record.providerId,
    label,
    url: record.sourceUrl,
  });
}

function normalizeOrderRecord(record: ShipStationOrderRecord): {
  order: NormalizedOrder;
  shipment?: NormalizedShipment;
  customer?: NormalizedCustomer;
} {
  if (record.version === "v2") {
    const normalized = normalizeV2Shipment(record.shipment);
    const customer = recipientFromV2Shipment(record.shipment);
    return {
      ...normalized,
      ...(customer ? { customer } : {}),
    };
  }
  const order = normalizeV1Order(record.order);
  const customer = recipientFromV1Order(record.order);
  return { order, ...(customer ? { customer } : {}) };
}

function normalizeTrackingRecord(
  record: ShipStationTrackingRecord,
): NormalizedShipment {
  return record.version === "v2"
    ? normalizeV2Shipment(record.shipment).shipment
    : normalizeV1Shipment(record.shipment);
}

function uniqueCitations(records: readonly Citation[]): Citation[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.provider}:${record.providerId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const findOrders = defineTool({
  name: "shipstation_find_orders",
  description:
    "Find up to 20 ShipStation orders or shipments by order number or customer email.",
  risk: "read",
  requiresConfirmation: false,
  execution: "server",
  inputSchema: FindOrdersInput,
  outputSchema: FindOrdersOutput,
  async handler(input, context) {
    const search = await createShipStationClient(
      context.credentials,
      context.signal,
    ).findOrders({
      ...(input.orderNumber ? { orderNumber: input.orderNumber } : {}),
      ...(input.customerEmail ? { customerEmail: input.customerEmail } : {}),
      ...(input.externalId ? { externalId: input.externalId } : {}),
      ...(input.recipientName ? { recipientName: input.recipientName } : {}),
      ...(input.createdAtStart ? { createdAtStart: input.createdAtStart } : {}),
      ...(input.createdAtEnd ? { createdAtEnd: input.createdAtEnd } : {}),
    });
    const normalized = search.records.map(normalizeOrderRecord);
    const orders = normalized.map((record) => record.order);
    const customers = normalized.flatMap((record) =>
      record.customer ? [record.customer] : [],
    );
    return {
      orders,
      customers,
      citations: uniqueCitations([
        ...orders.map(citation),
        ...customers.map(citation),
      ]),
      incomplete: search.incomplete,
    };
  },
});

const getOrder = defineTool({
  name: "shipstation_get_order",
  description:
    "Get one ShipStation order or shipment by its version-specific provider id.",
  risk: "read",
  requiresConfirmation: false,
  execution: "server",
  inputSchema: ProviderIdInput,
  outputSchema: GetOrderOutput,
  async handler(input, context) {
    const record = await createShipStationClient(
      context.credentials,
      context.signal,
    ).getOrder(input.providerId);
    if (!record) {
      return {
        order: null,
        shipment: null,
        customer: null,
        citations: [],
      };
    }
    const normalized = normalizeOrderRecord(record);
    const records = [
      normalized.order,
      ...(normalized.shipment ? [normalized.shipment] : []),
      ...(normalized.customer ? [normalized.customer] : []),
    ];
    return {
      order: normalized.order,
      shipment: normalized.shipment ?? null,
      customer: normalized.customer ?? null,
      citations: records.map(citation),
    };
  },
});

const getTracking = defineTool({
  name: "shipstation_get_tracking",
  description:
    "Get carrier, service, tracking number, and shipment status by provider id.",
  risk: "read",
  requiresConfirmation: false,
  execution: "server",
  inputSchema: ProviderIdInput,
  outputSchema: GetTrackingOutput,
  async handler(input, context) {
    const record = await createShipStationClient(
      context.credentials,
      context.signal,
    ).getTracking(input.providerId);
    const shipment = record ? normalizeTrackingRecord(record) : null;
    return {
      shipment,
      citations: shipment ? [citation(shipment)] : [],
    };
  },
});

const findCustomerByPhone = defineTool({
  name: "shipstation_find_customer_by_phone",
  description:
    "Find a ShipStation customer by phone, with order records when available.",
  risk: "read",
  requiresConfirmation: false,
  execution: "server",
  inputSchema: z.strictObject({
    phone: z.string().min(7).max(40),
    countryCode: z.string().max(4).optional(),
  }),
  outputSchema: PhoneSearchOutputSchema,
  async handler(input, context) {
    return createShipStationPhoneClient(
      context.credentials,
      context.signal,
    ).findCustomerByPhone({
      phone: input.phone,
      ...(input.countryCode ? { countryCode: input.countryCode } : {}),
    });
  },
});

export const shipstationSkill = defineSkill({
  id: "shipstation",
  name: "ShipStation",
  version: "1.1.0",
  instructions:
    "Use ShipStation tools for shipment, carrier, service, recipient, tracking, and customer phone lookup facts. Preserve the configured API version's provider id. Do not infer tracking events that are absent. If a search reports incomplete: true, tell the agent the bounded scan may have missed older records.",
  credentials: [
    {
      settingName: "shipstation_mode",
      headerName: "x-resolve-shipstation-mode",
      required: true,
      secret: false,
    },
    {
      settingName: "shipstation_v2_key",
      headerName: "x-resolve-shipstation-v2-key",
      required: false,
      secret: true,
    },
    {
      settingName: "shipstation_v1_key",
      headerName: "x-resolve-shipstation-v1-key",
      required: false,
      secret: true,
    },
    {
      settingName: "shipstation_v1_secret",
      headerName: "x-resolve-shipstation-v1-secret",
      required: false,
      secret: true,
    },
  ],
  tools: [findOrders, getOrder, getTracking, findCustomerByPhone],
  isConfigured(credentials) {
    const mode = credentials.shipstationMode ?? "auto";
    if (mode === "v2") return Boolean(credentials.shipstationV2Key);
    if (mode === "v1") {
      return Boolean(
        credentials.shipstationV1Key && credentials.shipstationV1Secret,
      );
    }
    return Boolean(
      credentials.shipstationV2Key ||
      (credentials.shipstationV1Key && credentials.shipstationV1Secret),
    );
  },
  async healthCheck(context) {
    await createShipStationClient(context.credentials, context.signal).health();
    return { ok: true, message: "ShipStation is reachable." };
  },
});
