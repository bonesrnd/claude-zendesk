import { afterEach, describe, expect, it, vi } from "vitest";

import customerFixture from "./fixtures/customer.json";
import { WooCommerceClient, WooCommerceHttpError } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WooCommerceClient", () => {
  it("requires an HTTPS store origin", () => {
    expect(
      () =>
        new WooCommerceClient({
          baseUrl: "http://store.example",
          consumerKey: "ck_test",
          consumerSecret: "cs_test",
          signal: new AbortController().signal,
        }),
    ).toThrow("WooCommerce URL must use HTTPS");
  });

  it("uses bounded requests and Basic authorization", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json([customerFixture]));
    vi.stubGlobal("fetch", fetchMock);
    const client = new WooCommerceClient({
      baseUrl: "https://store.example/",
      consumerKey: "ck_test",
      consumerSecret: "cs_test",
      signal: new AbortController().signal,
    });

    const customers = await client.findCustomersByEmail("maya@example.com");

    expect(customers).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://store.example/wp-json/wc/v3/customers?email=maya%40example.com&per_page=20",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Basic ${btoa("ck_test:cs_test")}`,
    );
  });

  it("maps authentication failures without exposing the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("credential detail", { status: 401 })),
    );
    const client = new WooCommerceClient({
      baseUrl: "https://store.example",
      consumerKey: "ck_test",
      consumerSecret: "cs_test",
      signal: new AbortController().signal,
    });

    await expect(
      client.findCustomersByEmail("maya@example.com"),
    ).rejects.toEqual(
      expect.objectContaining<Partial<WooCommerceHttpError>>({
        name: "WooCommerceHttpError",
        status: 401,
        code: "configuration_error",
      }),
    );
  });

  it("returns undefined for a missing customer id", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockImplementation(async () => new Response(null, { status: 404 })),
    );
    const client = new WooCommerceClient({
      baseUrl: "https://store.example",
      consumerKey: "ck_test",
      consumerSecret: "cs_test",
      signal: new AbortController().signal,
    });

    await expect(client.getCustomer(999)).resolves.toBeUndefined();
  });
});
