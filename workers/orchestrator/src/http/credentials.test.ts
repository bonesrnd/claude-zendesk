import { describe, expect, it } from "vitest";

import { readCredentials } from "./credentials";

describe("readCredentials", () => {
  it("reads integration settings only from headers", () => {
    const headers = new Headers({
      "x-resolve-anthropic-key": "anthropic-secret",
      "x-resolve-anthropic-model": "claude-test",
      "x-resolve-woo-url": "https://store.example",
      "x-resolve-woo-key": "woo-key",
      "x-resolve-woo-secret": "woo-secret",
      "x-resolve-shipstation-mode": "v2",
      "x-resolve-shipstation-v2-key": "ship-key",
    });

    expect(readCredentials(headers)).toEqual({
      anthropicApiKey: "anthropic-secret",
      anthropicModel: "claude-test",
      wooBaseUrl: "https://store.example",
      wooConsumerKey: "woo-key",
      wooConsumerSecret: "woo-secret",
      shipstationMode: "v2",
      shipstationV2Key: "ship-key",
      shipstationV1Key: undefined,
      shipstationV1Secret: undefined,
    });
  });
});
