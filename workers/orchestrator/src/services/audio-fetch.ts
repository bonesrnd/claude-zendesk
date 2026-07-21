export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const AUDIO_FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface FetchedAudio {
  bytes: Uint8Array;
  mediaType: string;
}

function ipv4Octets(hostname: string): number[] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map(Number);
  return octets.every(
    (octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255,
  )
    ? octets
    : undefined;
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = ipv4Octets(hostname);
  if (!octets) return false;
  const [first = -1, second = -1] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const address = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!address.includes(":")) return false;
  const mappedIpv4 = address.slice(address.lastIndexOf(":") + 1);
  if (mappedIpv4.includes(".") && isPrivateIpv4(mappedIpv4)) return true;
  const normalizedMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(
    address,
  );
  if (normalizedMapped) {
    const high = Number.parseInt(normalizedMapped[1] ?? "", 16);
    const low = Number.parseInt(normalizedMapped[2] ?? "", 16);
    const mapped = [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join(".");
    if (isPrivateIpv4(mapped)) return true;
  }
  if (address === "::" || address === "::1") return true;
  const firstHextet = Number.parseInt(address.split(":")[0] ?? "", 16);
  return (firstHextet & 0xfe00) === 0xfc00 || (firstHextet & 0xffc0) === 0xfe80;
}

function validatedUrl(value: string, base?: URL): URL {
  let url: URL;
  try {
    url = base ? new URL(value, base) : new URL(value);
  } catch {
    throw new Error("Recording URL is invalid");
  }
  if (url.protocol !== "https:") {
    throw new Error("Recording URL must use HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Recording URL must not contain credentials");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    isPrivateIpv4(hostname) ||
    isPrivateIpv6(hostname)
  ) {
    throw new Error("Recording URL must use a public address");
  }
  return url;
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_AUDIO_BYTES) {
      throw new Error("Recording exceeds the 25 MB audio limit");
    }
  }
  if (!response.body) {
    throw new Error("Recording response did not contain audio");
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_AUDIO_BYTES) {
        await reader.cancel("audio size limit exceeded");
        throw new Error("Recording exceeds the 25 MB audio limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function fetchBoundedAudio(
  value: string,
  signal: AbortSignal,
): Promise<FetchedAudio> {
  let url = validatedUrl(value);
  const boundedSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(AUDIO_FETCH_TIMEOUT_MS),
  ]);

  for (let redirects = 0; ; redirects += 1) {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "audio/*" },
      redirect: "manual",
      signal: boundedSignal,
    });
    if (REDIRECT_STATUSES.has(response.status)) {
      if (redirects >= MAX_REDIRECTS) {
        throw new Error("Recording exceeded the redirect limit");
      }
      const location = response.headers.get("location");
      if (!location) throw new Error("Recording redirect had no location");
      url = validatedUrl(location, url);
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `Recording request failed with status ${response.status}`,
      );
    }

    const mediaType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (!mediaType?.startsWith("audio/")) {
      throw new Error("Recording response was not audio");
    }
    return {
      bytes: await readBoundedBody(response),
      mediaType,
    };
  }
}
