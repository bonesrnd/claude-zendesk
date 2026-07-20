const MAX_JSON_BYTES = 1_000_000;

export class JsonRequestError extends Error {
  override readonly name = "JsonRequestError";
}

export async function readJsonBody(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new JsonRequestError("Content-Type must be application/json");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_JSON_BYTES) {
    throw new JsonRequestError("JSON body is too large");
  }

  if (!request.body) throw new JsonRequestError("JSON body is required");
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new JsonRequestError("JSON body is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new JsonRequestError("JSON body is invalid");
  }
}
