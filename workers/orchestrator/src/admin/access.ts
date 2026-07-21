const ACCESS_CERTS_PATH = "/cdn-cgi/access/certs";
const KEY_CACHE_TTL_MS = 60 * 60 * 1_000;
const UNKNOWN_KID_TTL_MS = 60 * 1_000;
const MAX_UNKNOWN_KIDS = 128;

interface CachedAccessKeys {
  expiresAt: number;
  keys?: ReadonlyMap<string, CryptoKey>;
  refresh?: Promise<ReadonlyMap<string, CryptoKey>>;
  unknownKids: Map<string, number>;
  unknownRefreshAfter: number;
}

export type AccessKeyCache = Map<string, CachedAccessKeys>;

export interface AccessIdentity {
  subject: string;
  email?: string;
}

export type AccessVerificationResult =
  | { ok: true; identity: AccessIdentity }
  | {
      ok: false;
      reason:
        | "missing"
        | "malformed"
        | "configuration"
        | "keys"
        | "signature"
        | "expired"
        | "not_active"
        | "audience"
        | "issuer";
    };

interface AccessConfiguration {
  teamDomain: string;
  audience: string;
}

interface AccessVerificationDependencies {
  fetcher?: typeof fetch;
  now?: () => number;
  cache?: AccessKeyCache;
}

interface JwtHeader {
  alg?: unknown;
  kid?: unknown;
}

interface JwtClaims {
  aud?: unknown;
  email?: unknown;
  exp?: unknown;
  iss?: unknown;
  nbf?: unknown;
  sub?: unknown;
}

const accessKeyCache: AccessKeyCache = new Map();

function configuredOrigin(teamDomain: string): string | undefined {
  try {
    const candidate = teamDomain.includes("://")
      ? teamDomain
      : `https://${teamDomain}`;
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.pathname !== "/" && url.pathname !== "") ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function decodeJson<T>(segment: string): T {
  const padded = segment.replaceAll("-", "+").replaceAll("_", "/");
  const remainder = padded.length % 4;
  const base64 =
    remainder === 0
      ? padded
      : padded.padEnd(padded.length + 4 - remainder, "=");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function decodeBytes(segment: string): Uint8Array {
  const padded = segment.replaceAll("-", "+").replaceAll("_", "/");
  const remainder = padded.length % 4;
  const base64 =
    remainder === 0
      ? padded
      : padded.padEnd(padded.length + 4 - remainder, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isAccessJwk(
  candidate: unknown,
): candidate is JsonWebKey & { kid: string } {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    "kid" in candidate &&
    typeof candidate.kid === "string" &&
    "kty" in candidate &&
    candidate.kty === "RSA" &&
    "n" in candidate &&
    typeof candidate.n === "string" &&
    "e" in candidate &&
    typeof candidate.e === "string" &&
    (!("alg" in candidate) || candidate.alg === "RS256") &&
    (!("use" in candidate) || candidate.use === "sig")
  );
}

async function fetchAccessKeys(
  origin: string,
  fetcher: typeof fetch,
): Promise<ReadonlyMap<string, CryptoKey>> {
  const response = await fetcher(`${origin}${ACCESS_CERTS_PATH}`, {
    headers: { accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok) throw new Error("Access key fetch failed");
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("keys" in body) ||
    !Array.isArray(body.keys)
  ) {
    throw new Error("Access key set is invalid");
  }
  const candidates: readonly unknown[] = body.keys;

  const keys = new Map<string, CryptoKey>();
  for (const candidate of candidates) {
    if (!isAccessJwk(candidate)) continue;
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        candidate,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      keys.set(candidate.kid, key);
    } catch {
      // Ignore malformed keys while retaining any valid keys in the set.
    }
  }
  if (keys.size === 0) throw new Error("Access key set is empty");
  return keys;
}

function cacheEntry(cache: AccessKeyCache, origin: string): CachedAccessKeys {
  const existing = cache.get(origin);
  if (existing) return existing;
  const created: CachedAccessKeys = {
    expiresAt: 0,
    unknownKids: new Map(),
    unknownRefreshAfter: 0,
  };
  cache.set(origin, created);
  return created;
}

async function refreshAccessKeys(
  origin: string,
  fetcher: typeof fetch,
  cache: AccessKeyCache,
  now: number,
): Promise<ReadonlyMap<string, CryptoKey>> {
  const entry = cacheEntry(cache, origin);
  if (entry.refresh) return entry.refresh;
  const pending = fetchAccessKeys(origin, fetcher)
    .then((keys) => {
      entry.keys = keys;
      entry.expiresAt = now + KEY_CACHE_TTL_MS;
      entry.unknownKids.clear();
      return keys;
    })
    .finally(() => {
      if (entry.refresh === pending) delete entry.refresh;
    });
  entry.refresh = pending;
  return pending;
}

async function accessKeys(
  origin: string,
  fetcher: typeof fetch,
  cache: AccessKeyCache,
  now: number,
): Promise<{ keys: ReadonlyMap<string, CryptoKey>; refreshed: boolean }> {
  const entry = cacheEntry(cache, origin);
  if (entry.keys && entry.expiresAt > now) {
    return { keys: entry.keys, refreshed: false };
  }
  return {
    keys: await refreshAccessKeys(origin, fetcher, cache, now),
    refreshed: true,
  };
}

function unknownKidIsCached(
  entry: CachedAccessKeys,
  kid: string,
  now: number,
): boolean {
  for (const [cachedKid, expiresAt] of entry.unknownKids) {
    if (expiresAt <= now) entry.unknownKids.delete(cachedKid);
  }
  return (entry.unknownKids.get(kid) ?? 0) > now;
}

function rememberUnknownKid(
  entry: CachedAccessKeys,
  kid: string,
  now: number,
): void {
  if (
    !entry.unknownKids.has(kid) &&
    entry.unknownKids.size >= MAX_UNKNOWN_KIDS
  ) {
    const oldest = entry.unknownKids.keys().next().value;
    if (typeof oldest === "string") entry.unknownKids.delete(oldest);
  }
  entry.unknownKids.set(kid, now + UNKNOWN_KID_TTL_MS);
}

function audienceMatches(claim: unknown, configured: string): boolean {
  return typeof claim === "string"
    ? claim === configured
    : Array.isArray(claim) && claim.some((value) => value === configured);
}

export async function verifyAccessRequest(
  request: Request,
  configuration: AccessConfiguration,
  dependencies: AccessVerificationDependencies = {},
): Promise<AccessVerificationResult> {
  const assertion = request.headers.get("cf-access-jwt-assertion")?.trim();
  if (!assertion) return { ok: false, reason: "missing" };

  const origin = configuredOrigin(configuration.teamDomain.trim());
  if (!origin || !configuration.audience.trim()) {
    return { ok: false, reason: "configuration" };
  }

  const segments = assertion.split(".");
  if (segments.length !== 3 || segments.some((segment) => !segment)) {
    return { ok: false, reason: "malformed" };
  }

  let header: JwtHeader;
  let claims: JwtClaims;
  let signature: Uint8Array;
  try {
    header = decodeJson<JwtHeader>(segments[0]!);
    claims = decodeJson<JwtClaims>(segments[1]!);
    signature = decodeBytes(segments[2]!);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    header.alg !== "RS256" ||
    typeof header.kid !== "string" ||
    !header.kid ||
    header.kid.length > 200
  ) {
    return { ok: false, reason: "malformed" };
  }

  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now?.() ?? Date.now();
  const cache = dependencies.cache ?? accessKeyCache;
  let keys: ReadonlyMap<string, CryptoKey>;
  let refreshed: boolean;
  try {
    const loaded = await accessKeys(origin, fetcher, cache, now);
    keys = loaded.keys;
    refreshed = loaded.refreshed;
    const entry = cacheEntry(cache, origin);
    if (!keys.has(header.kid) && unknownKidIsCached(entry, header.kid, now)) {
      return { ok: false, reason: "signature" };
    }
    if (!keys.has(header.kid) && !refreshed) {
      if (entry.unknownRefreshAfter > now) {
        rememberUnknownKid(entry, header.kid, now);
        return { ok: false, reason: "signature" };
      }
      keys = await refreshAccessKeys(origin, fetcher, cache, now);
    }
    if (!keys.has(header.kid)) {
      entry.unknownRefreshAfter = now + UNKNOWN_KID_TTL_MS;
      rememberUnknownKid(entry, header.kid, now);
    }
  } catch {
    return { ok: false, reason: "keys" };
  }
  const key = keys.get(header.kid);
  if (!key) return { ok: false, reason: "signature" };

  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    new TextEncoder().encode(`${segments[0]}.${segments[1]}`),
  );
  if (!verified) return { ok: false, reason: "signature" };

  const nowSeconds = Math.floor(now / 1_000);
  if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) {
    return { ok: false, reason: "expired" };
  }
  if (typeof claims.nbf === "number" && claims.nbf > nowSeconds) {
    return { ok: false, reason: "not_active" };
  }
  if (!audienceMatches(claims.aud, configuration.audience.trim())) {
    return { ok: false, reason: "audience" };
  }
  if (
    typeof claims.iss !== "string" ||
    claims.iss.replace(/\/$/u, "") !== origin
  ) {
    return { ok: false, reason: "issuer" };
  }
  if (typeof claims.sub !== "string" || !claims.sub) {
    return { ok: false, reason: "malformed" };
  }

  return {
    ok: true,
    identity: {
      subject: claims.sub,
      ...(typeof claims.email === "string" && claims.email
        ? { email: claims.email }
        : {}),
    },
  };
}
