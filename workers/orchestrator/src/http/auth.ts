const encoder = new TextEncoder();

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

export async function authenticate(
  request: Request,
  expectedToken: string,
): Promise<boolean> {
  const header = request.headers.get("authorization");
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const [actualHash, expectedHash] = await Promise.all([
    digest(supplied),
    digest(expectedToken),
  ]);
  return crypto.subtle.timingSafeEqual(actualHash, expectedHash);
}
