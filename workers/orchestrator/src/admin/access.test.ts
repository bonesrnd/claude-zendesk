import { beforeAll, describe, expect, it, vi } from "vitest";

import { verifyAccessRequest, type AccessKeyCache } from "./access";

const TEAM_DOMAIN = "resolve.cloudflareaccess.com";
const AUDIENCE = "access-audience";
const NOW_SECONDS = 1_800_000_000;

let trustedKeys: CryptoKeyPair;
let attackerKeys: CryptoKeyPair;
let trustedJwk: JsonWebKey;

function base64Url(value: string | Uint8Array): string {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function assertion(
  overrides: Record<string, unknown> = {},
  keys: CryptoKeyPair = trustedKeys,
  headerOverrides: Record<string, unknown> = {},
): Promise<string> {
  const header = base64Url(
    JSON.stringify({
      alg: "RS256",
      kid: "trusted-key",
      typ: "JWT",
      ...headerOverrides,
    }),
  );
  const payload = base64Url(
    JSON.stringify({
      aud: [AUDIENCE],
      email: "admin@example.com",
      exp: NOW_SECONDS + 300,
      iat: NOW_SECONDS - 30,
      iss: `https://${TEAM_DOMAIN}`,
      sub: "access-user",
      ...overrides,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keys.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

function request(token?: string): Request {
  const headers = new Headers();
  if (token) headers.set("cf-access-jwt-assertion", token);
  return new Request("https://worker.test/admin/knowledge", { headers });
}

function dependencies(now: () => number = () => NOW_SECONDS * 1_000) {
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`https://${TEAM_DOMAIN}/cdn-cgi/access/certs`);
      expect(init?.redirect).toBe("error");
      return Response.json({
        keys: [{ ...trustedJwk, kid: "trusted-key", alg: "RS256", use: "sig" }],
      });
    },
  );
  return {
    fetcher,
    now,
    cache: new Map() as AccessKeyCache,
  };
}

beforeAll(async () => {
  trustedKeys = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  attackerKeys = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  trustedJwk = (await crypto.subtle.exportKey(
    "jwk",
    trustedKeys.publicKey,
  )) as JsonWebKey;
});

describe("verifyAccessRequest", () => {
  it("rejects a missing Access assertion", async () => {
    const result = await verifyAccessRequest(
      request(),
      { teamDomain: TEAM_DOMAIN, audience: AUDIENCE },
      dependencies(),
    );

    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects an expired assertion", async () => {
    const result = await verifyAccessRequest(
      request(await assertion({ exp: NOW_SECONDS - 1 })),
      { teamDomain: TEAM_DOMAIN, audience: AUDIENCE },
      dependencies(),
    );

    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects an assertion for another audience", async () => {
    const result = await verifyAccessRequest(
      request(await assertion({ aud: ["another-application"] })),
      { teamDomain: TEAM_DOMAIN, audience: AUDIENCE },
      dependencies(),
    );

    expect(result).toEqual({ ok: false, reason: "audience" });
  });

  it("rejects an assertion from another issuer", async () => {
    const result = await verifyAccessRequest(
      request(
        await assertion({ iss: "https://attacker.cloudflareaccess.com" }),
      ),
      { teamDomain: TEAM_DOMAIN, audience: AUDIENCE },
      dependencies(),
    );

    expect(result).toEqual({ ok: false, reason: "issuer" });
  });

  it("rejects an assertion with an invalid signature", async () => {
    const result = await verifyAccessRequest(
      request(await assertion({}, attackerKeys)),
      { teamDomain: TEAM_DOMAIN, audience: AUDIENCE },
      dependencies(),
    );

    expect(result).toEqual({ ok: false, reason: "signature" });
  });

  it("accepts a valid assertion and caches only configured-domain keys", async () => {
    const deps = dependencies();
    const token = await assertion();

    const first = await verifyAccessRequest(
      request(token),
      { teamDomain: `https://${TEAM_DOMAIN}`, audience: AUDIENCE },
      deps,
    );
    const second = await verifyAccessRequest(
      request(token),
      { teamDomain: TEAM_DOMAIN, audience: AUDIENCE },
      deps,
    );

    expect(first).toEqual({
      ok: true,
      identity: {
        email: "admin@example.com",
        subject: "access-user",
      },
    });
    expect(second.ok).toBe(true);
    expect(deps.fetcher).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent JWKS refreshes for an unknown kid", async () => {
    const deps = dependencies();
    const token = await assertion({}, trustedKeys, { kid: "unknown-key" });

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        verifyAccessRequest(
          request(token),
          { teamDomain: TEAM_DOMAIN, audience: AUDIENCE },
          deps,
        ),
      ),
    );

    expect(results).toEqual(
      Array.from({ length: 20 }, () => ({
        ok: false,
        reason: "signature",
      })),
    );
    expect(deps.fetcher).toHaveBeenCalledTimes(1);
  });

  it("negative-caches unknown kids for a bounded TTL", async () => {
    let now = NOW_SECONDS * 1_000;
    const deps = dependencies(() => now);
    const token = await assertion({}, trustedKeys, { kid: "unknown-key" });
    const verify = () =>
      verifyAccessRequest(
        request(token),
        { teamDomain: TEAM_DOMAIN, audience: AUDIENCE },
        deps,
      );

    await verify();
    await verify();
    expect(deps.fetcher).toHaveBeenCalledTimes(1);

    now += 60_001;
    await verify();
    expect(deps.fetcher).toHaveBeenCalledTimes(2);
  });

  it("rate-limits refreshes across distinct unknown kids", async () => {
    const deps = dependencies();
    const first = await assertion({}, trustedKeys, { kid: "unknown-one" });
    const second = await assertion({}, trustedKeys, { kid: "unknown-two" });

    await verifyAccessRequest(
      request(first),
      { teamDomain: TEAM_DOMAIN, audience: AUDIENCE },
      deps,
    );
    await verifyAccessRequest(
      request(second),
      { teamDomain: TEAM_DOMAIN, audience: AUDIENCE },
      deps,
    );

    expect(deps.fetcher).toHaveBeenCalledTimes(1);
  });
});
