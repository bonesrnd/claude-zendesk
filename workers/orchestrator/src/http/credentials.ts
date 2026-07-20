export interface RequestCredentials {
  anthropicApiKey: string | undefined;
  anthropicModel: string;
  wooBaseUrl: string | undefined;
  wooConsumerKey: string | undefined;
  wooConsumerSecret: string | undefined;
  shipstationMode: string;
  shipstationV2Key: string | undefined;
  shipstationV1Key: string | undefined;
  shipstationV1Secret: string | undefined;
}

function value(headers: Headers, name: string): string | undefined {
  const result = headers.get(name)?.trim();
  return result ? result : undefined;
}

export function readCredentials(
  headers: Headers,
  pinned: { wooBaseUrl?: string } = {},
): RequestCredentials {
  return {
    anthropicApiKey: value(headers, "x-resolve-anthropic-key"),
    anthropicModel:
      value(headers, "x-resolve-anthropic-model") ??
      "claude-sonnet-4-5-20250929",
    wooBaseUrl: pinned.wooBaseUrl ?? value(headers, "x-resolve-woo-url"),
    wooConsumerKey: value(headers, "x-resolve-woo-key"),
    wooConsumerSecret: value(headers, "x-resolve-woo-secret"),
    shipstationMode: value(headers, "x-resolve-shipstation-mode") ?? "auto",
    shipstationV2Key: value(headers, "x-resolve-shipstation-v2-key"),
    shipstationV1Key: value(headers, "x-resolve-shipstation-v1-key"),
    shipstationV1Secret: value(headers, "x-resolve-shipstation-v1-secret"),
  };
}
