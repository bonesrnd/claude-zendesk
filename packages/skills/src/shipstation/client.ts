import {
  CitationSchema,
  PhoneSearchResultSchema,
  type Citation,
  type NormalizedCustomer,
  type NormalizedOrder,
  type NormalizedPhone,
  type PhoneSearchResult,
} from "@resolve/contracts";
import type { ZodType } from "zod";

import {
  ShipStationV1CustomerListSchema,
  ShipStationV1OrderListSchema,
  ShipStationV1OrderSchema,
  ShipStationV1ShipmentListSchema,
  ShipStationV2ListSchema,
  ShipStationV2ShipmentSchema,
  type ShipStationV1Order,
  type ShipStationV1Shipment,
  type ShipStationV2Shipment,
} from "./schemas";
import {
  normalizeV1Customer,
  normalizeV2Shipment,
  recipientFromV2Shipment,
} from "./normalize";
import { normalizedPhonesMatch, normalizePhone } from "./phone";

const MAX_RESPONSE_BYTES = 2_000_000;

export type ShipStationMode = "v2" | "v1" | "auto";

export type ShipStationOrderRecord =
  | { version: "v2"; shipment: ShipStationV2Shipment }
  | { version: "v1"; order: ShipStationV1Order };

export type ShipStationTrackingRecord =
  | { version: "v2"; shipment: ShipStationV2Shipment }
  | { version: "v1"; shipment: ShipStationV1Shipment };

export interface ShipStationSearchResult {
  records: ShipStationOrderRecord[];
  incomplete: boolean;
}

export interface ShipStationClient {
  readonly version: "v2" | "v1";
  findOrders(input: {
    orderNumber?: string;
    customerEmail?: string;
    externalId?: string;
    recipientName?: string;
    createdAtStart?: string;
    createdAtEnd?: string;
  }): Promise<ShipStationSearchResult>;
  getOrder(providerId: string): Promise<ShipStationOrderRecord | undefined>;
  getTracking(
    providerId: string,
  ): Promise<ShipStationTrackingRecord | undefined>;
  findCustomerByPhone(input: {
    phone: string;
    countryCode?: string;
  }): Promise<PhoneSearchResult>;
  health(): Promise<void>;
}

function phoneCitation(record: NormalizedCustomer | NormalizedOrder): Citation {
  return CitationSchema.parse({
    provider: "shipstation",
    providerId: record.providerId,
    label:
      "orderNumber" in record
        ? `ShipStation ${record.orderNumber}`
        : `ShipStation customer ${record.name}`,
    url: record.sourceUrl,
  });
}

function phoneSearchResult(input: {
  customers: NormalizedCustomer[];
  orders: NormalizedOrder[];
  searchedRecords: number;
  incomplete: boolean;
  apiVersion: "v1" | "v2";
}): PhoneSearchResult {
  const citations = [...input.customers, ...input.orders]
    .map(phoneCitation)
    .filter(
      (citation, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.provider === citation.provider &&
            candidate.providerId === citation.providerId,
        ) === index,
    );
  return PhoneSearchResultSchema.parse({ ...input, citations });
}

function phoneMatches(
  expected: NormalizedPhone,
  candidate: string,
  countryCode?: string,
): boolean {
  try {
    return normalizedPhonesMatch(
      expected,
      normalizePhone(candidate, countryCode),
    );
  } catch {
    return false;
  }
}

export class ShipStationHttpError extends Error {
  override readonly name = "ShipStationHttpError";

  constructor(
    readonly status: number,
    readonly code: "configuration_error" | "integration_error",
  ) {
    super(
      code === "configuration_error"
        ? "ShipStation authentication failed"
        : "ShipStation request failed",
    );
  }
}

async function readJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_RESPONSE_BYTES) {
    throw new ShipStationHttpError(502, "integration_error");
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ShipStationHttpError(502, "integration_error");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

abstract class BaseShipStationClient {
  constructor(
    private readonly baseUrl: string,
    private readonly headers: HeadersInit,
    protected readonly signal: AbortSignal,
  ) {}

  protected async request<T>(
    path: string,
    params: Record<string, string>,
    schema: ZodType<T>,
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        ...this.headers,
      },
      signal: this.signal,
    });
    if (!response.ok) {
      throw new ShipStationHttpError(
        response.status,
        response.status === 401 || response.status === 403
          ? "configuration_error"
          : "integration_error",
      );
    }
    return schema.parse(await readJson(response));
  }
}

export class ShipStationV2Client
  extends BaseShipStationClient
  implements ShipStationClient
{
  readonly version = "v2" as const;

  constructor(apiKey: string, signal: AbortSignal) {
    super("https://api.shipstation.com", { "api-key": apiKey }, signal);
  }

  async findOrders(input: {
    orderNumber?: string;
    customerEmail?: string;
    externalId?: string;
    recipientName?: string;
    createdAtStart?: string;
    createdAtEnd?: string;
  }): Promise<ShipStationSearchResult> {
    const matches: ShipStationOrderRecord[] = [];
    const needsLocalFilter = Boolean(input.customerEmail);
    let incomplete = false;
    for (let page = 1; page <= 5 && matches.length < 20; page += 1) {
      const response = await this.request(
        "/v2/shipments",
        {
          ...(input.orderNumber ? { shipment_number: input.orderNumber } : {}),
          ...(input.externalId
            ? { external_shipment_id: input.externalId }
            : {}),
          ...(input.recipientName ? { ship_to_name: input.recipientName } : {}),
          ...(input.createdAtStart
            ? { created_at_start: input.createdAtStart }
            : {}),
          ...(input.createdAtEnd ? { created_at_end: input.createdAtEnd } : {}),
          ...(page > 1 ? { page: String(page) } : {}),
          page_size: "20",
          sort_by: "created_at",
          sort_dir: "desc",
        },
        ShipStationV2ListSchema,
      );
      matches.push(
        ...response.shipments
          .filter(
            (shipment) =>
              !input.customerEmail ||
              shipment.ship_to?.email?.toLowerCase() ===
                input.customerEmail.toLowerCase(),
          )
          .map((shipment) => ({ version: "v2" as const, shipment })),
      );
      const hasMore =
        response.pages !== undefined
          ? page < response.pages
          : response.shipments.length === 20;
      if (!needsLocalFilter || !hasMore) {
        break;
      }
      if (page === 5) incomplete = true;
    }
    return { records: matches.slice(0, 20), incomplete };
  }

  async getOrder(
    providerId: string,
  ): Promise<ShipStationOrderRecord | undefined> {
    const shipment = await this.request(
      `/v2/shipments/${encodeURIComponent(providerId)}`,
      {},
      ShipStationV2ShipmentSchema,
    );
    return { version: "v2", shipment };
  }

  async getTracking(
    providerId: string,
  ): Promise<ShipStationTrackingRecord | undefined> {
    const shipment = await this.request(
      `/v2/shipments/${encodeURIComponent(providerId)}`,
      {},
      ShipStationV2ShipmentSchema,
    );
    return { version: "v2", shipment };
  }

  async findCustomerByPhone(input: {
    phone: string;
    countryCode?: string;
  }): Promise<PhoneSearchResult> {
    const phone = normalizePhone(input.phone, input.countryCode);
    let searchedRecords = 0;
    let incomplete = false;
    for (let page = 1; page <= 5; page += 1) {
      const response = await this.request(
        "/v2/shipments",
        {
          ...(page > 1 ? { page: String(page) } : {}),
          page_size: "100",
          sort_by: "created_at",
          sort_dir: "desc",
        },
        ShipStationV2ListSchema,
      );
      searchedRecords += response.shipments.length;
      const hasMore =
        response.pages !== undefined
          ? page < response.pages
          : response.shipments.length === 100;
      if (page === 5 && hasMore) incomplete = true;
      const matches = response.shipments
        .filter(
          (shipment) =>
            shipment.ship_to?.phone &&
            phoneMatches(phone, shipment.ship_to.phone, input.countryCode),
        )
        .slice(0, 20);
      if (matches.length > 0) {
        const normalized = matches.map((shipment) => ({
          order: normalizeV2Shipment(shipment).order,
          customer: recipientFromV2Shipment(shipment),
        }));
        return phoneSearchResult({
          customers: normalized.flatMap(({ customer }) =>
            customer ? [customer] : [],
          ),
          orders: normalized.map(({ order }) => order),
          searchedRecords,
          incomplete: incomplete || hasMore,
          apiVersion: this.version,
        });
      }

      if (!hasMore) break;
    }
    return phoneSearchResult({
      customers: [],
      orders: [],
      searchedRecords,
      incomplete,
      apiVersion: this.version,
    });
  }

  async health(): Promise<void> {
    await this.request(
      "/v2/shipments",
      { page_size: "1" },
      ShipStationV2ListSchema,
    );
  }
}

export class ShipStationV1Client
  extends BaseShipStationClient
  implements ShipStationClient
{
  readonly version = "v1" as const;

  constructor(apiKey: string, apiSecret: string, signal: AbortSignal) {
    super(
      "https://ssapi.shipstation.com",
      { authorization: `Basic ${btoa(`${apiKey}:${apiSecret}`)}` },
      signal,
    );
  }

  async findOrders(input: {
    orderNumber?: string;
    customerEmail?: string;
    externalId?: string;
    recipientName?: string;
    createdAtStart?: string;
    createdAtEnd?: string;
  }): Promise<ShipStationSearchResult> {
    const response = await this.request(
      "/orders",
      {
        ...(input.orderNumber ? { orderNumber: input.orderNumber } : {}),
        ...(input.customerEmail ? { customerEmail: input.customerEmail } : {}),
        ...(input.externalId ? { orderKey: input.externalId } : {}),
        ...(input.recipientName ? { customerName: input.recipientName } : {}),
        ...(input.createdAtStart
          ? { orderDateStart: input.createdAtStart }
          : {}),
        ...(input.createdAtEnd ? { orderDateEnd: input.createdAtEnd } : {}),
        pageSize: "20",
        page: "1",
      },
      ShipStationV1OrderListSchema,
    );
    return {
      records: response.orders.map((order) => ({
        version: "v1",
        order,
      })),
      incomplete: false,
    };
  }

  async getOrder(
    providerId: string,
  ): Promise<ShipStationOrderRecord | undefined> {
    const order = await this.request(
      `/orders/${encodeURIComponent(providerId)}`,
      {},
      ShipStationV1OrderSchema,
    );
    return { version: "v1", order };
  }

  async getTracking(
    providerId: string,
  ): Promise<ShipStationTrackingRecord | undefined> {
    const response = await this.request(
      "/shipments",
      { orderId: providerId, pageSize: "20", page: "1" },
      ShipStationV1ShipmentListSchema,
    );
    const shipment = response.shipments[0];
    return shipment ? { version: "v1", shipment } : undefined;
  }

  async findCustomerByPhone(input: {
    phone: string;
    countryCode?: string;
  }): Promise<PhoneSearchResult> {
    const phone = normalizePhone(input.phone, input.countryCode);
    let searchedRecords = 0;
    let incomplete = false;
    for (let page = 1; page <= 10; page += 1) {
      const response = await this.request(
        "/customers",
        { pageSize: "500", page: String(page) },
        ShipStationV1CustomerListSchema,
      );
      searchedRecords += response.customers.length;
      const currentPage = response.page ?? page;
      const hasMore =
        response.pages !== undefined
          ? currentPage < response.pages
          : response.customers.length === 500;
      if (page === 10 && hasMore) incomplete = true;
      const customers = response.customers
        .filter(
          (customer) =>
            customer.phone &&
            phoneMatches(phone, customer.phone, input.countryCode),
        )
        .slice(0, 20)
        .map(normalizeV1Customer);
      if (customers.length > 0) {
        return phoneSearchResult({
          customers,
          orders: [],
          searchedRecords,
          incomplete: incomplete || hasMore,
          apiVersion: this.version,
        });
      }

      if (!hasMore) break;
    }
    return phoneSearchResult({
      customers: [],
      orders: [],
      searchedRecords,
      incomplete,
      apiVersion: this.version,
    });
  }

  async health(): Promise<void> {
    await this.request(
      "/orders",
      { pageSize: "1", page: "1" },
      ShipStationV1OrderListSchema,
    );
  }
}

export function createShipStationClient(
  credentials: Readonly<Record<string, string | undefined>>,
  signal: AbortSignal,
): ShipStationClient {
  const mode = credentials.shipstationMode ?? "auto";
  if (!["v2", "v1", "auto"].includes(mode)) {
    throw new Error("ShipStation mode is invalid");
  }
  if (mode === "v2" || (mode === "auto" && credentials.shipstationV2Key)) {
    if (!credentials.shipstationV2Key) {
      throw new Error("ShipStation v2 is not configured");
    }
    return new ShipStationV2Client(credentials.shipstationV2Key, signal);
  }
  if (credentials.shipstationV1Key && credentials.shipstationV1Secret) {
    return new ShipStationV1Client(
      credentials.shipstationV1Key,
      credentials.shipstationV1Secret,
      signal,
    );
  }
  throw new Error("ShipStation v1 is not configured");
}

export function createShipStationPhoneClient(
  credentials: Readonly<Record<string, string | undefined>>,
  signal: AbortSignal,
): ShipStationClient {
  const mode = credentials.shipstationMode ?? "auto";
  if (!["v2", "v1", "auto"].includes(mode)) {
    throw new Error("ShipStation mode is invalid");
  }
  if (mode !== "v2") {
    if (credentials.shipstationV1Key && credentials.shipstationV1Secret) {
      return new ShipStationV1Client(
        credentials.shipstationV1Key,
        credentials.shipstationV1Secret,
        signal,
      );
    }
    if (mode === "v1") {
      throw new Error("ShipStation v1 is not configured");
    }
  }
  if (credentials.shipstationV2Key) {
    return new ShipStationV2Client(credentials.shipstationV2Key, signal);
  }
  throw new Error("ShipStation v2 is not configured");
}
