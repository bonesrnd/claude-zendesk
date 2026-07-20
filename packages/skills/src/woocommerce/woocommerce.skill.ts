import {
  CitationSchema,
  NormalizedCustomerSchema,
  NormalizedOrderSchema,
} from "@resolve/contracts";
import {
  defineSkill,
  defineTool,
  type ToolExecutionContext,
} from "@resolve/skill-sdk";
import { z } from "zod";

import { WooCommerceClient } from "./client";
import { normalizeWooCustomer, normalizeWooOrder } from "./normalize";

const FindCustomerInput = z
  .strictObject({
    email: z.email().optional(),
    customerId: z.number().int().positive().optional(),
  })
  .refine((input) => input.email || input.customerId, {
    message: "Provide email or customerId",
  });
const FindCustomerOutput = z.strictObject({
  customer: NormalizedCustomerSchema.nullable(),
  citations: z.array(CitationSchema),
});

const ListOrdersInput = z
  .strictObject({
    customerId: z.number().int().positive().optional(),
    email: z.email().optional(),
  })
  .refine((input) => input.customerId !== undefined || input.email, {
    message: "Provide customerId or email",
  });
const ListOrdersOutput = z.strictObject({
  orders: z.array(NormalizedOrderSchema).max(20),
  citations: z.array(CitationSchema).max(20),
});

const GetOrderInput = z.strictObject({
  orderIdOrNumber: z.string().min(1).max(100),
});
const GetOrderOutput = z.strictObject({
  order: NormalizedOrderSchema.nullable(),
  citations: z.array(CitationSchema).max(1),
});

function configuredValue(context: ToolExecutionContext, key: string): string {
  const value = context.credentials[key]?.trim();
  if (!value) throw new Error("WooCommerce is not configured");
  return value;
}

function client(context: ToolExecutionContext): WooCommerceClient {
  return new WooCommerceClient({
    baseUrl: configuredValue(context, "wooBaseUrl"),
    consumerKey: configuredValue(context, "wooConsumerKey"),
    consumerSecret: configuredValue(context, "wooConsumerSecret"),
    signal: context.signal,
  });
}

function citation(record: {
  providerId: string;
  sourceUrl: string;
  orderNumber?: string;
  name?: string;
}) {
  return CitationSchema.parse({
    provider: "woocommerce",
    providerId: record.providerId,
    label: record.orderNumber
      ? `WooCommerce order ${record.orderNumber}`
      : `WooCommerce customer ${record.name ?? record.providerId}`,
    url: record.sourceUrl,
  });
}

const findCustomer = defineTool({
  name: "woocommerce_find_customer",
  description:
    "Find a WooCommerce customer by exact email address or customer id.",
  risk: "read",
  requiresConfirmation: false,
  execution: "server",
  inputSchema: FindCustomerInput,
  outputSchema: FindCustomerOutput,
  async handler(input, context) {
    const woo = client(context);
    const found = input.customerId
      ? await woo.getCustomer(input.customerId)
      : (await woo.findCustomersByEmail(input.email ?? ""))[0];
    const customer = found
      ? normalizeWooCustomer(found, configuredValue(context, "wooBaseUrl"))
      : null;
    return {
      customer,
      citations: customer ? [citation(customer)] : [],
    };
  },
});

const listOrders = defineTool({
  name: "woocommerce_list_orders",
  description:
    "List up to 20 recent WooCommerce orders for a customer id or email.",
  risk: "read",
  requiresConfirmation: false,
  execution: "server",
  inputSchema: ListOrdersInput,
  outputSchema: ListOrdersOutput,
  async handler(input, context) {
    const storeUrl = configuredValue(context, "wooBaseUrl");
    const orders = (
      await client(context).listOrders({
        ...(input.customerId ? { customerId: input.customerId } : {}),
        ...(input.email ? { email: input.email } : {}),
      })
    ).map((order) => normalizeWooOrder(order, storeUrl));
    return {
      orders,
      citations: orders.map(citation),
    };
  },
});

const getOrder = defineTool({
  name: "woocommerce_get_order",
  description:
    "Get one WooCommerce order by provider id or exact order number.",
  risk: "read",
  requiresConfirmation: false,
  execution: "server",
  inputSchema: GetOrderInput,
  outputSchema: GetOrderOutput,
  async handler(input, context) {
    const order = await client(context).getOrder(input.orderIdOrNumber);
    const normalized = order
      ? normalizeWooOrder(order, configuredValue(context, "wooBaseUrl"))
      : null;
    return {
      order: normalized,
      citations: normalized ? [citation(normalized)] : [],
    };
  },
});

export const woocommerceSkill = defineSkill({
  id: "woocommerce",
  name: "WooCommerce",
  version: "1.0.0",
  instructions:
    "Use WooCommerce tools for customer and order facts. If a lookup returns no exact record, say so. Do not infer order state.",
  credentials: [
    {
      settingName: "woo_solution_peptides_base_url",
      headerName: "x-resolve-woo-solution-peptides-url",
      required: true,
      secret: false,
    },
    {
      settingName: "woo_solution_peptides_consumer_key",
      headerName: "x-resolve-woo-solution-peptides-key",
      required: true,
      secret: true,
    },
    {
      settingName: "woo_solution_peptides_consumer_secret",
      headerName: "x-resolve-woo-solution-peptides-secret",
      required: true,
      secret: true,
    },
    {
      settingName: "woo_atomik_labz_base_url",
      headerName: "x-resolve-woo-atomik-labz-url",
      required: true,
      secret: false,
    },
    {
      settingName: "woo_atomik_labz_consumer_key",
      headerName: "x-resolve-woo-atomik-labz-key",
      required: true,
      secret: true,
    },
    {
      settingName: "woo_atomik_labz_consumer_secret",
      headerName: "x-resolve-woo-atomik-labz-secret",
      required: true,
      secret: true,
    },
  ],
  tools: [findCustomer, listOrders, getOrder],
  isConfigured(credentials) {
    return Boolean(
      credentials.wooBaseUrl &&
      credentials.wooConsumerKey &&
      credentials.wooConsumerSecret,
    );
  },
  async healthCheck(context) {
    await client(context).listCustomers();
    return { ok: true, message: "WooCommerce is reachable." };
  },
});
