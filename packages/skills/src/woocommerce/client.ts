import type { ZodType } from "zod";

import {
  WooCustomerListSchema,
  WooOrderListSchema,
  WooOrderSchema,
  type WooCustomer,
  type WooOrder,
} from "./schemas";

const MAX_RESPONSE_BYTES = 2_000_000;

export class WooCommerceHttpError extends Error {
  override readonly name = "WooCommerceHttpError";

  constructor(
    readonly status: number,
    readonly code: "configuration_error" | "integration_error",
  ) {
    super(
      code === "configuration_error"
        ? "WooCommerce authentication failed"
        : "WooCommerce request failed",
    );
  }
}

interface WooCommerceClientOptions {
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  signal: AbortSignal;
}

async function readJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_RESPONSE_BYTES) {
    throw new WooCommerceHttpError(502, "integration_error");
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
      throw new WooCommerceHttpError(502, "integration_error");
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

export class WooCommerceClient {
  readonly baseUrl: string;
  private readonly authorization: string;
  private readonly signal: AbortSignal;

  constructor(options: WooCommerceClientOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "https:") {
      throw new Error("WooCommerce URL must use HTTPS");
    }
    this.baseUrl = url.origin;
    this.authorization = `Basic ${btoa(
      `${options.consumerKey}:${options.consumerSecret}`,
    )}`;
    this.signal = options.signal;
  }

  private async request<T>(
    path: string,
    params: Record<string, string>,
    schema: ZodType<T>,
  ): Promise<T> {
    const url = new URL(`/wp-json/wc/v3/${path}`, this.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        authorization: this.authorization,
      },
      signal: this.signal,
    });
    if (!response.ok) {
      throw new WooCommerceHttpError(
        response.status,
        response.status === 401 || response.status === 403
          ? "configuration_error"
          : "integration_error",
      );
    }
    return schema.parse(await readJson(response));
  }

  findCustomersByEmail(email: string): Promise<WooCustomer[]> {
    return this.request(
      "customers",
      { email, per_page: "20" },
      WooCustomerListSchema,
    );
  }

  async getCustomer(customerId: number): Promise<WooCustomer | undefined> {
    try {
      return await this.request(
        `customers/${customerId}`,
        {},
        WooCustomerListSchema.element,
      );
    } catch (error) {
      if (error instanceof WooCommerceHttpError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  listCustomers(): Promise<WooCustomer[]> {
    return this.request("customers", { per_page: "1" }, WooCustomerListSchema);
  }

  listOrders(input: {
    customerId?: number;
    email?: string;
  }): Promise<WooOrder[]> {
    return this.request(
      "orders",
      {
        ...(input.customerId
          ? { customer: String(input.customerId) }
          : { search: input.email ?? "" }),
        orderby: "date",
        order: "desc",
        per_page: "20",
      },
      WooOrderListSchema,
    );
  }

  async getOrder(idOrNumber: string): Promise<WooOrder | undefined> {
    if (/^\d+$/.test(idOrNumber)) {
      try {
        return await this.request(`orders/${idOrNumber}`, {}, WooOrderSchema);
      } catch (error) {
        if (!(error instanceof WooCommerceHttpError) || error.status !== 404) {
          throw error;
        }
      }
    }
    const matches = await this.request(
      "orders",
      { search: idOrNumber, per_page: "20" },
      WooOrderListSchema,
    );
    return matches.find((order) => order.number === idOrNumber);
  }
}
