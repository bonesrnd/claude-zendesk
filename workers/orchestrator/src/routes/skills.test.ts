import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

function request(
  path: string,
  options: { method?: string; headers?: HeadersInit; body?: unknown } = {},
) {
  return exports.default.fetch(
    new Request(`https://worker.test${path}`, {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${env.BACKEND_AUTH_TOKEN}`,
        "x-resolve-tenant": env.TENANT_KEY,
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("skills routes", () => {
  it("returns capabilities and boolean configuration status only", async () => {
    const response = await request("/v1/skills", {
      headers: {
        "x-resolve-woo-url": "https://store.example",
        "x-resolve-woo-key": "woo-secret-key",
        "x-resolve-woo-secret": "woo-secret-value",
      },
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("woo-secret-key");
    expect(text).not.toContain("woo-secret-value");
    expect(JSON.parse(text)).toMatchObject({
      skills: [
        { id: "zendesk", configured: true },
        { id: "woocommerce", configured: true },
        { id: "shipstation" },
      ],
    });
  });

  it("runs a configured skill health check", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () => Response.json([])),
    );

    const response = await request("/v1/skills/woocommerce/health", {
      method: "POST",
      headers: {
        "x-resolve-woo-url": "https://store.example",
        "x-resolve-woo-key": "woo-key",
        "x-resolve-woo-secret": "woo-secret",
      },
      body: { ticketId: 8421 },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "woocommerce",
      ok: true,
      message: "WooCommerce is reachable.",
    });
  });

  it("reports an unconfigured skill without naming secret values", async () => {
    const response = await request("/v1/skills/woocommerce/health", {
      method: "POST",
      body: { ticketId: 8421 },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      kind: "error",
      code: "configuration_error",
      integration: "woocommerce",
    });
  });

  it("rejects a caller-controlled WooCommerce origin before forwarding credentials", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json([]));
    vi.stubGlobal("fetch", fetchMock);

    const response = await request("/v1/skills/woocommerce/health", {
      method: "POST",
      headers: {
        "x-resolve-woo-url": "https://attacker.example",
        "x-resolve-woo-key": "woo-key",
        "x-resolve-woo-secret": "woo-secret",
      },
      body: { ticketId: 8421 },
    });

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
