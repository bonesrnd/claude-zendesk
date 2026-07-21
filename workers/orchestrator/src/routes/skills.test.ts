import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

const solutionPeptidesBrand = {
  id: 123,
  name: "Solution Peptides",
  subdomain: "solutionpeptides",
};

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
        "x-resolve-woo-solution-peptides-url": "https://solutionpeptides.net",
        "x-resolve-woo-solution-peptides-key": "woo-sp-key",
        "x-resolve-woo-solution-peptides-secret": "woo-sp-secret",
        "x-resolve-woo-atomik-labz-url": "https://atomiklabz.com",
        "x-resolve-woo-atomik-labz-key": "woo-atomik-key",
        "x-resolve-woo-atomik-labz-secret": "woo-atomik-secret",
      },
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("woo-sp-key");
    expect(text).not.toContain("woo-atomik-secret");
    expect(JSON.parse(text)).toMatchObject({
      skills: [
        { id: "zendesk", configured: true },
        {
          id: "woocommerce",
          configured: true,
          connections: [
            { id: "solution_peptides", configured: true },
            { id: "atomik_labz", configured: true },
          ],
        },
        { id: "shipstation" },
        { id: "knowledge", configured: true },
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
        "x-resolve-woo-solution-peptides-url": "https://solutionpeptides.net",
        "x-resolve-woo-solution-peptides-key": "woo-key",
        "x-resolve-woo-solution-peptides-secret": "woo-secret",
      },
      body: { ticketId: 8421, brand: solutionPeptidesBrand },
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
      body: { ticketId: 8421, brand: solutionPeptidesBrand },
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
        "x-resolve-woo-solution-peptides-url": "https://attacker.example",
        "x-resolve-woo-solution-peptides-key": "woo-key",
        "x-resolve-woo-solution-peptides-secret": "woo-secret",
      },
      body: { ticketId: 8421, brand: solutionPeptidesBrand },
    });

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
