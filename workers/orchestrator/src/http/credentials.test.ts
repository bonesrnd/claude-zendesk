import { describe, expect, it } from "vitest";

import { readCredentials, resolveWooStoreForBrand } from "./credentials";

describe("readCredentials", () => {
  it("reads integration settings only from headers", () => {
    const headers = new Headers({
      "x-resolve-anthropic-key": "anthropic-secret",
      "x-resolve-anthropic-model": "claude-test",
      "x-resolve-woo-atomik-labz-key": "woo-key",
      "x-resolve-woo-atomik-labz-secret": "woo-secret",
      "x-resolve-shipstation-mode": "v2",
      "x-resolve-shipstation-v2-key": "ship-key",
    });

    expect(
      readCredentials(headers, {
        baseUrl: "https://atomiklabz.com",
        keyHeader: "x-resolve-woo-atomik-labz-key",
        secretHeader: "x-resolve-woo-atomik-labz-secret",
      }),
    ).toEqual({
      anthropicApiKey: "anthropic-secret",
      anthropicModel: "claude-test",
      wooBaseUrl: "https://atomiklabz.com",
      wooConsumerKey: "woo-key",
      wooConsumerSecret: "woo-secret",
      shipstationMode: "v2",
      shipstationV2Key: "ship-key",
      shipstationV1Key: undefined,
      shipstationV1Secret: undefined,
    });
  });

  it("maps only approved Zendesk brands to WooCommerce stores", () => {
    expect(
      resolveWooStoreForBrand({
        id: 1,
        name: "Solution Peptides",
        subdomain: "solutionpeptides",
      }),
    ).toBe("solution_peptides");
    expect(
      resolveWooStoreForBrand({
        id: 2,
        name: "Atomik Labz",
        subdomain: "atomiklabz",
      }),
    ).toBe("atomik_labz");
    expect(
      resolveWooStoreForBrand({ id: 3, name: "Unknown Store" }),
    ).toBeUndefined();
  });
});
