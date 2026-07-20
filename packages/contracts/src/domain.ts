import { z } from "zod";

export const RequesterSchema = z.strictObject({
  id: z.number().int().positive(),
  name: z.string().min(1).max(200),
  email: z.email().optional(),
});

export const TicketContextSchema = z.strictObject({
  ticketId: z.number().int().positive(),
  subject: z.string().max(500),
  requester: RequesterSchema,
  recentConversation: z
    .array(
      z.strictObject({
        authorName: z.string().max(200),
        body: z.string().max(20_000),
        createdAt: z.iso.datetime(),
        public: z.boolean(),
      }),
    )
    .max(30),
});

export const CitationSchema = z.strictObject({
  provider: z.enum(["zendesk", "woocommerce", "shipstation"]),
  label: z.string().min(1).max(200),
  providerId: z.string().min(1).max(200),
  url: z.url(),
});

export const ToolEventSchema = z.strictObject({
  skillId: z.string().min(1),
  toolName: z.string().min(1),
  status: z.enum(["running", "succeeded", "failed"]),
  summary: z.string().max(1_000),
});

export const MetadataEntrySchema = z.strictObject({
  key: z.string().min(1).max(200),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});

export const NormalizedCustomerSchema = z.strictObject({
  provider: z.enum(["woocommerce", "shipstation"]),
  providerId: z.string().min(1),
  name: z.string().max(300),
  email: z.email().optional(),
  phone: z.string().max(100).optional(),
  sourceUrl: z.url(),
});

export const AddressSummarySchema = z.strictObject({
  name: z.string().max(300),
  company: z.string().max(300).optional(),
  city: z.string().max(200).optional(),
  state: z.string().max(200).optional(),
  postalCode: z.string().max(100).optional(),
  country: z.string().max(100).optional(),
  email: z.email().optional(),
  phone: z.string().max(100).optional(),
});

export const RefundSummarySchema = z.strictObject({
  providerId: z.string().min(1),
  reason: z.string().max(1_000).optional(),
  total: z.string().max(50),
});

export const NormalizedOrderSchema = z.strictObject({
  provider: z.enum(["woocommerce", "shipstation"]),
  providerId: z.string().min(1),
  orderNumber: z.string().min(1),
  status: z.string().min(1),
  createdAt: z.iso.datetime().optional(),
  currency: z.string().max(10).optional(),
  total: z.string().max(50).optional(),
  shippingMethod: z.string().max(300).optional(),
  trackingNumber: z.string().max(300).optional(),
  billingSummary: AddressSummarySchema.optional(),
  shippingSummary: AddressSummarySchema.optional(),
  refunds: z.array(RefundSummarySchema).max(100).default([]),
  sourceUrl: z.url(),
  lineItems: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(500),
        quantity: z.number().int().nonnegative(),
        sku: z.string().max(200).optional(),
      }),
    )
    .max(200),
  metadata: z.array(MetadataEntrySchema).max(200),
});

export const NormalizedShipmentSchema = z.strictObject({
  provider: z.literal("shipstation"),
  providerId: z.string().min(1),
  orderNumber: z.string().optional(),
  status: z.string().min(1),
  carrier: z.string().max(200).optional(),
  service: z.string().max(300).optional(),
  trackingNumber: z.string().max(300).optional(),
  shipDate: z.iso.datetime().optional(),
  sourceUrl: z.url(),
});

export type Requester = z.infer<typeof RequesterSchema>;
export type TicketContext = z.infer<typeof TicketContextSchema>;
export type Citation = z.infer<typeof CitationSchema>;
export type ToolEvent = z.infer<typeof ToolEventSchema>;
export type MetadataEntry = z.infer<typeof MetadataEntrySchema>;
export type NormalizedCustomer = z.infer<typeof NormalizedCustomerSchema>;
export type AddressSummary = z.infer<typeof AddressSummarySchema>;
export type RefundSummary = z.infer<typeof RefundSummarySchema>;
export type NormalizedOrder = z.infer<typeof NormalizedOrderSchema>;
export type NormalizedShipment = z.infer<typeof NormalizedShipmentSchema>;
