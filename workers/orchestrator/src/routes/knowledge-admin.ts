import { renderKnowledgeAdminHtml } from "../admin/knowledge-html";
import { embedKnowledgeDocuments } from "../knowledge/embed";
import {
  KnowledgeConflictError,
  KnowledgeNotFoundError,
  KnowledgeRepository,
  KnowledgeValidationError,
  type IngestKnowledgeDocument,
  type KnowledgeDocument,
} from "../repositories/knowledge";

export interface KnowledgeAdminRepository {
  listDocuments(): Promise<KnowledgeDocument[]>;
  ingest(input: IngestKnowledgeDocument): Promise<KnowledgeDocument>;
  deleteDocument(documentId: string): Promise<boolean>;
}

interface KnowledgeAdminDependencies {
  repository: KnowledgeAdminRepository;
  nonce?: () => string;
}

const MAX_KNOWLEDGE_FILE_BYTES = 5 * 1024 * 1024;
const MAX_MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_UPLOAD_REQUEST_BYTES =
  MAX_KNOWLEDGE_FILE_BYTES + MAX_MULTIPART_OVERHEAD_BYTES;

function securityHeaders(headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  result.set("cache-control", "no-store");
  result.set("referrer-policy", "no-referrer");
  result.set("x-content-type-options", "nosniff");
  result.set("x-frame-options", "DENY");
  return result;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: securityHeaders(),
  });
}

function mutationOriginMatches(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

async function uploadedFile(file: File): Promise<{
  filename: string;
  bytes: Uint8Array;
}> {
  return {
    filename: file.name,
    bytes: new Uint8Array(await file.arrayBuffer()),
  };
}

async function singleUploadFile(request: Request): Promise<File | Response> {
  const contentLength = request.headers.get("content-length");
  if (contentLength === null || !/^\d+$/u.test(contentLength)) {
    return json(
      { error: "A positive decimal Content-Length header is required." },
      411,
    );
  }
  const declaredLength = BigInt(contentLength);
  if (declaredLength === 0n) {
    return json(
      { error: "A positive decimal Content-Length header is required." },
      411,
    );
  }
  if (declaredLength > BigInt(MAX_UPLOAD_REQUEST_BYTES)) {
    return json({ error: "Upload request is too large." }, 413);
  }
  const form = await request.formData();
  const files = [...form.values()].filter(
    (value): value is File => value instanceof File,
  );
  const namedFiles = form
    .getAll("file")
    .filter((value): value is File => value instanceof File);
  if (
    files.length !== 1 ||
    namedFiles.length !== 1 ||
    files[0] !== namedFiles[0]
  ) {
    return json(
      { error: "Exactly one Markdown file is required per request." },
      400,
    );
  }
  const file = namedFiles[0]!;
  if (file.size > MAX_KNOWLEDGE_FILE_BYTES) {
    return json({ error: "Knowledge files cannot exceed 5 MB." }, 413);
  }
  if (!file.name.toLowerCase().endsWith(".md")) {
    return json({ error: "Knowledge files must use the .md extension." }, 400);
  }
  return file;
}

function safeIndexingError(error: unknown): string {
  return error instanceof KnowledgeValidationError
    ? error.message
    : "Indexing failed; the previous version was retained.";
}

export function createKnowledgeAdminHandler(
  dependencies: KnowledgeAdminDependencies,
): (request: Request) => Promise<Response> {
  const nonce = dependencies.nonce ?? (() => crypto.randomUUID());

  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/admin/knowledge") {
      const documents = await dependencies.repository.listDocuments();
      const pageNonce = nonce();
      const headers = securityHeaders({
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": [
          "default-src 'none'",
          `script-src 'nonce-${pageNonce}'`,
          `style-src 'nonce-${pageNonce}'`,
          "connect-src 'self'",
          "base-uri 'none'",
          "form-action 'self'",
          "frame-ancestors 'none'",
        ].join("; "),
      });
      return new Response(renderKnowledgeAdminHtml(documents, pageNonce), {
        headers,
      });
    }

    if (request.method === "GET" && pathname === "/admin/api/knowledge") {
      return json({
        documents: await dependencies.repository.listDocuments(),
      });
    }

    if (
      ["POST", "PUT", "DELETE"].includes(request.method) &&
      !mutationOriginMatches(request)
    ) {
      return json({ error: "Cross-origin mutation is not allowed." }, 403);
    }

    if (request.method === "POST" && pathname === "/admin/api/knowledge") {
      const file = await singleUploadFile(request);
      if (file instanceof Response) return file;
      try {
        const upload = await uploadedFile(file);
        const document = await dependencies.repository.ingest(upload);
        return json(
          { result: { ok: true, filename: file.name, document } },
          202,
        );
      } catch (error) {
        return json(
          {
            result: {
              ok: false,
              filename: file.name,
              error: safeIndexingError(error),
            },
          },
          422,
        );
      }
    }

    const documentMatch = pathname.match(/^\/admin\/api\/knowledge\/([^/]+)$/u);
    if (documentMatch?.[1] && request.method === "PUT") {
      const documentId = decodeURIComponent(documentMatch[1]);
      const file = await singleUploadFile(request);
      if (file instanceof Response) return file;
      try {
        const upload = await uploadedFile(file);
        const document = await dependencies.repository.ingest({
          ...upload,
          documentId,
        });
        return json({ document }, 202);
      } catch (error) {
        if (error instanceof KnowledgeNotFoundError) {
          return json({ error: error.message }, 404);
        }
        if (error instanceof KnowledgeConflictError) {
          return json({ error: error.message }, 409);
        }
        return json(
          {
            error: safeIndexingError(error),
            filename: file.name,
          },
          422,
        );
      }
    }

    if (documentMatch?.[1] && request.method === "DELETE") {
      const documentId = decodeURIComponent(documentMatch[1]);
      try {
        const deleted =
          await dependencies.repository.deleteDocument(documentId);
        return deleted
          ? new Response(null, { status: 204, headers: securityHeaders() })
          : json({ error: "Knowledge document was not found." }, 404);
      } catch (error) {
        return error instanceof KnowledgeValidationError
          ? json({ error: error.message }, 400)
          : json({ error: "Knowledge deletion failed." }, 502);
      }
    }

    return json({ error: "The requested admin route does not exist." }, 404);
  };
}

export async function handleKnowledgeAdmin(
  request: Request,
  env: Env,
): Promise<Response> {
  const repository = new KnowledgeRepository({
    db: env.DB,
    bucket: env.KNOWLEDGE_BUCKET,
    index: env.KNOWLEDGE_INDEX,
    queue: env.KNOWLEDGE_INDEX_QUEUE,
    embedDocuments: (documents) => embedKnowledgeDocuments(env.AI, documents),
  });
  return createKnowledgeAdminHandler({ repository })(request);
}
