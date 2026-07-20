import { z } from "zod";

export const WooMetadataSchema = z.object({
  id: z.number().int().optional(),
  key: z.string(),
  value: z.unknown(),
});

export const WooLineItemSchema = z.object({
  name: z.string(),
  quantity: z.number().int().nonnegative(),
  sku: z.string().optional().default(""),
});

export const WooAddressSchema = z.object({
  first_name: z.string().optional().default(""),
  last_name: z.string().optional().default(""),
  company: z.string().optional().default(""),
  city: z.string().optional().default(""),
  state: z.string().optional().default(""),
  postcode: z.string().optional().default(""),
  country: z.string().optional().default(""),
  email: z.string().optional().default(""),
  phone: z.string().optional().default(""),
});

export const WooOrderSchema = z.object({
  id: z.number().int().positive(),
  number: z.string(),
  status: z.string(),
  date_created_gmt: z.string().nullable().optional(),
  currency: z.string().optional(),
  total: z.string().optional(),
  customer_id: z.number().int().nonnegative().optional(),
  line_items: z.array(WooLineItemSchema).default([]),
  shipping_lines: z
    .array(
      z.object({
        method_title: z.string().optional(),
      }),
    )
    .default([]),
  billing: WooAddressSchema.optional(),
  shipping: WooAddressSchema.optional(),
  refunds: z
    .array(
      z.object({
        id: z.number().int().positive(),
        reason: z.string().optional().default(""),
        total: z.string(),
      }),
    )
    .optional()
    .default([]),
  meta_data: z.array(WooMetadataSchema).default([]),
});

export const WooCustomerSchema = z.object({
  id: z.number().int().positive(),
  email: z.string().optional().default(""),
  first_name: z.string().optional().default(""),
  last_name: z.string().optional().default(""),
  billing: z
    .object({
      phone: z.string().optional().default(""),
    })
    .optional(),
});

export const WooOrderListSchema = z.array(WooOrderSchema);
export const WooCustomerListSchema = z.array(WooCustomerSchema);

export type WooOrder = z.infer<typeof WooOrderSchema>;
export type WooCustomer = z.infer<typeof WooCustomerSchema>;
export type WooAddress = z.infer<typeof WooAddressSchema>;
