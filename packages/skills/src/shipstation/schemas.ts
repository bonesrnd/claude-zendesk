import { z } from "zod";

const RecipientSchema = z.object({
  name: z.string().optional().default(""),
  email: z.string().nullable().optional(),
  phone: z.string().optional().default(""),
});

const ProductSchema = z.object({
  name: z.string().optional().default("Item"),
  quantity: z.number().int().nonnegative().optional().default(0),
  sku: z.string().nullable().optional(),
});

export const ShipStationV2ShipmentSchema = z.object({
  shipment_id: z.string().min(1),
  shipment_number: z.string().nullable().optional(),
  external_order_id: z.string().nullable().optional(),
  external_shipment_id: z.string().nullable().optional(),
  shipment_status: z.string().min(1),
  created_at: z.string().optional(),
  ship_date: z.string().nullable().optional(),
  carrier_id: z.string().nullable().optional(),
  service_code: z.string().nullable().optional(),
  tracking_number: z.string().nullable().optional(),
  ship_to: RecipientSchema.optional(),
  packages: z
    .array(
      z.object({
        products: z.array(ProductSchema).optional().default([]),
      }),
    )
    .optional()
    .default([]),
});

export const ShipStationV2ListSchema = z.object({
  shipments: z.array(ShipStationV2ShipmentSchema),
  total: z.number().optional(),
  pages: z.number().optional(),
});

export const ShipStationV1OrderSchema = z.object({
  orderId: z.number().int().positive(),
  orderNumber: z.string().min(1),
  orderStatus: z.string().min(1),
  orderDate: z.string().optional(),
  customerEmail: z.string().optional().default(""),
  amountPaid: z.number().optional(),
  carrierCode: z.string().nullable().optional(),
  serviceCode: z.string().nullable().optional(),
  shipTo: RecipientSchema.optional(),
  items: z.array(ProductSchema).optional().default([]),
  tagIds: z.array(z.number().int()).optional().default([]),
});

export const ShipStationV1OrderListSchema = z.object({
  orders: z.array(ShipStationV1OrderSchema),
  total: z.number().optional(),
  page: z.number().optional(),
  pages: z.number().optional(),
});

export const ShipStationV1ShipmentSchema = z.object({
  shipmentId: z.number().int().positive(),
  orderId: z.number().int().positive().optional(),
  orderNumber: z.string().optional(),
  shipmentStatus: z.string().optional().default("shipped"),
  createDate: z.string().optional(),
  shipDate: z.string().optional(),
  carrierCode: z.string().nullable().optional(),
  serviceCode: z.string().nullable().optional(),
  trackingNumber: z.string().nullable().optional(),
  shipTo: RecipientSchema.optional(),
});

export const ShipStationV1ShipmentListSchema = z.object({
  shipments: z.array(ShipStationV1ShipmentSchema),
  total: z.number().optional(),
  page: z.number().optional(),
  pages: z.number().optional(),
});

export type ShipStationV2Shipment = z.infer<typeof ShipStationV2ShipmentSchema>;
export type ShipStationV1Order = z.infer<typeof ShipStationV1OrderSchema>;
export type ShipStationV1Shipment = z.infer<typeof ShipStationV1ShipmentSchema>;
