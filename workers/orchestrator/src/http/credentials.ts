import type { TicketBrand } from "@resolve/contracts";

export type WooStoreKey = "solution_peptides" | "atomik_labz";

export interface WooCredentialSource {
  baseUrl: string;
  keyHeader: string;
  secretHeader: string;
}

export const WOO_STORE_HEADERS = {
  solution_peptides: {
    url: "x-resolve-woo-solution-peptides-url",
    key: "x-resolve-woo-solution-peptides-key",
    secret: "x-resolve-woo-solution-peptides-secret",
  },
  atomik_labz: {
    url: "x-resolve-woo-atomik-labz-url",
    key: "x-resolve-woo-atomik-labz-key",
    secret: "x-resolve-woo-atomik-labz-secret",
  },
} as const;

export interface RequestCredentials {
  anthropicApiKey: string | undefined;
  anthropicModel: string;
  anthropicEffort: string;
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

function normalizedBrand(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export function resolveWooStoreForBrand(
  brand: TicketBrand,
): WooStoreKey | undefined {
  const identifiers = new Set([
    normalizedBrand(brand.name),
    normalizedBrand(brand.subdomain),
  ]);
  if (identifiers.has("solution_peptides")) return "solution_peptides";
  if (identifiers.has("atomik_labz")) return "atomik_labz";
  return undefined;
}

export function wooCredentialSourceForStore(
  store: WooStoreKey,
  env: Env,
): WooCredentialSource {
  const headers = WOO_STORE_HEADERS[store];
  return {
    baseUrl:
      store === "solution_peptides"
        ? env.WOO_SOLUTION_PEPTIDES_BASE_URL
        : env.WOO_ATOMIK_LABZ_BASE_URL,
    keyHeader: headers.key,
    secretHeader: headers.secret,
  };
}

export function readCredentials(
  headers: Headers,
  woo?: WooCredentialSource,
): RequestCredentials {
  return {
    anthropicApiKey: value(headers, "x-resolve-anthropic-key"),
    anthropicModel:
      value(headers, "x-resolve-anthropic-model") ?? "claude-sonnet-5",
    anthropicEffort: value(headers, "x-resolve-anthropic-effort") ?? "medium",
    wooBaseUrl: woo?.baseUrl,
    wooConsumerKey: woo ? value(headers, woo.keyHeader) : undefined,
    wooConsumerSecret: woo ? value(headers, woo.secretHeader) : undefined,
    shipstationMode: value(headers, "x-resolve-shipstation-mode") ?? "auto",
    shipstationV2Key: value(headers, "x-resolve-shipstation-v2-key"),
    shipstationV1Key: value(headers, "x-resolve-shipstation-v1-key"),
    shipstationV1Secret: value(headers, "x-resolve-shipstation-v1-secret"),
  };
}
