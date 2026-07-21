import { describe, expect, it, vi } from "vitest";

import {
  KnowledgeDeletionError,
  KnowledgeNotFoundError,
} from "../repositories/knowledge";
import {
  createKnowledgeAdminHandler,
  type KnowledgeAdminRepository,
} from "./knowledge-admin";

const document = {
  id: "doc_123",
  filename: "returns.md",
  r2Key: "documents/doc_123/hash.md",
  contentSha256: "a".repeat(64),
  status: "queued" as const,
  chunkCount: 0,
  createdAt: "2026-07-21T12:00:00.000Z",
  updatedAt: "2026-07-21T12:00:00.000Z",
};

function uploadRequest(
  path: string,
  form: FormData,
  method: "POST" | "PUT" = "POST",
  contentLength = "1024",
): Request {
  return new Request(`https://worker.example${path}`, {
    method,
    headers: { "content-length": contentLength },
    body: form,
  });
}

function setup() {
  const listDocuments = vi.fn<KnowledgeAdminRepository["listDocuments"]>(
    async () => [document],
  );
  const ingest = vi.fn<KnowledgeAdminRepository["ingest"]>(
    async ({ filename, documentId }) => ({
      ...document,
      id: documentId ?? document.id,
      filename,
    }),
  );
  const deleteDocument = vi.fn<KnowledgeAdminRepository["deleteDocument"]>(
    async () => true,
  );
  const repository = {
    listDocuments,
    ingest,
    deleteDocument,
  } satisfies KnowledgeAdminRepository;
  return {
    repository,
    ingest,
    deleteDocument,
    handler: createKnowledgeAdminHandler({
      repository,
      nonce: () => "fixed-nonce",
    }),
  };
}

describe("knowledge admin portal", () => {
  it("serves a CSP-protected drag-and-drop portal without infrastructure secrets", async () => {
    const { handler } = setup();

    const response = await handler(
      new Request("https://worker.example/admin/knowledge"),
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "script-src 'nonce-fixed-nonce'",
    );
    expect(html).toContain("Drop Markdown files");
    expect(html).toContain("Upload progress");
    expect(html).toContain("Replace");
    expect(html).toContain("Delete");
    expect(html).toContain("returns.md");
    expect(html).not.toContain("CF_ACCESS_AUD");
    expect(html).not.toContain("KNOWLEDGE_BUCKET");
    expect(html).toContain("resolve({ ok: true");
    expect(html).toContain("const failures = []");
    expect(html).toContain("failures.push");
    expect(html).toContain('outcomes.join("\\n")');
    expect(html).toContain("if (result.ok) location.reload()");
    expect(html).toContain("const UPLOAD_CONCURRENCY = 3");
    expect(html).toContain("selected.slice(0, 50)");
    expect(html).toContain('form.append("file", file)');
    expect(html).not.toContain('form.append("files"');
  });

  it("returns indexing status as JSON", async () => {
    const { handler } = setup();

    const response = await handler(
      new Request("https://worker.example/admin/api/knowledge"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ documents: [document] });
  });

  it("stages exactly one Markdown file per HTTP request", async () => {
    const { handler, ingest } = setup();
    const form = new FormData();
    form.append("file", new File(["# One"], "one.md"));

    const request = uploadRequest("/admin/api/knowledge", form);
    const formData = vi.spyOn(request, "formData");
    const response = await handler(request);

    expect(response.status).toBe(202);
    expect(formData).toHaveBeenCalledOnce();
    expect(ingest).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toMatchObject({
      result: { ok: true, filename: "one.md" },
    });
  });

  it("rejects multiple files in one HTTP request", async () => {
    const { handler, ingest } = setup();
    const form = new FormData();
    form.append("file", new File(["# One"], "one.md"));
    form.append("file", new File(["# Two"], "two.md"));

    const response = await handler(uploadRequest("/admin/api/knowledge", form));

    expect(response.status).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("rejects an oversized file before reading its bytes", async () => {
    const { handler, ingest } = setup();
    const form = new FormData();
    const file = new File(
      [new Uint8Array(5 * 1024 * 1024 + 1)],
      "oversized.md",
    );
    const arrayBuffer = vi.spyOn(file, "arrayBuffer");
    form.append("file", file);

    const response = await handler(uploadRequest("/admin/api/knowledge", form));

    expect(response.status).toBe(413);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it("requires Content-Length before parsing multipart data", async () => {
    const { handler, ingest } = setup();
    const request = new Request("https://worker.example/admin/api/knowledge", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=unused",
      },
      body: "--unused--",
    });
    const formData = vi.spyOn(request, "formData");

    const response = await handler(request);

    expect(response.status).toBe(411);
    expect(formData).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  for (const contentLength of ["", "abc", "-1", "1.5", "0", "+1"]) {
    it(`rejects invalid Content-Length ${JSON.stringify(contentLength)} before parsing`, async () => {
      const { handler, ingest } = setup();
      const request = new Request(
        "https://worker.example/admin/api/knowledge",
        {
          method: "POST",
          headers: {
            "content-length": contentLength,
            "content-type": "multipart/form-data; boundary=unused",
          },
          body: "--unused--",
        },
      );
      const formData = vi.spyOn(request, "formData");

      const response = await handler(request);

      expect(response.status).toBe(411);
      expect(formData).not.toHaveBeenCalled();
      expect(ingest).not.toHaveBeenCalled();
    });
  }

  it("rejects an oversized request body before parsing multipart data", async () => {
    const { handler, ingest } = setup();
    const request = new Request("https://worker.example/admin/api/knowledge", {
      method: "POST",
      headers: {
        "content-length": String(5 * 1024 * 1024 + 64 * 1024 + 1),
        "content-type": "multipart/form-data; boundary=unused",
      },
      body: "--unused--",
    });
    const formData = vi.spyOn(request, "formData");

    const response = await handler(request);

    expect(response.status).toBe(413);
    expect(formData).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it("replaces a document only through its stable document id", async () => {
    const { handler, ingest } = setup();
    const form = new FormData();
    form.append("file", new File(["# Updated"], "renamed.md"));

    const response = await handler(
      uploadRequest("/admin/api/knowledge/doc_123", form, "PUT"),
    );

    expect(response.status).toBe(202);
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: "doc_123",
        filename: "renamed.md",
      }),
    );
  });

  it("returns 404 when replacing an unknown document id", async () => {
    const { handler, ingest } = setup();
    ingest.mockRejectedValueOnce(
      new KnowledgeNotFoundError("Knowledge document was not found."),
    );
    const form = new FormData();
    form.append("file", new File(["# Updated"], "renamed.md"));

    const response = await handler(
      uploadRequest("/admin/api/knowledge/doc_missing", form, "PUT"),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Knowledge document was not found.",
    });
  });

  it("requires explicit deletion and reports unknown documents", async () => {
    const { handler, deleteDocument } = setup();
    deleteDocument.mockResolvedValueOnce(false);

    const response = await handler(
      new Request("https://worker.example/admin/api/knowledge/missing", {
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(404);
    expect(deleteDocument).toHaveBeenCalledWith("missing");
  });

  it("returns non-success for failed cleanup and allows DELETE retry", async () => {
    const { handler, deleteDocument } = setup();
    deleteDocument
      .mockRejectedValueOnce(
        new KnowledgeDeletionError("Knowledge deletion requires retry."),
      )
      .mockResolvedValueOnce(true);
    const request = () =>
      new Request("https://worker.example/admin/api/knowledge/doc_123", {
        method: "DELETE",
      });

    const failed = await handler(request());
    const retried = await handler(request());

    expect(failed.status).toBe(502);
    expect(retried.status).toBe(204);
    expect(deleteDocument).toHaveBeenCalledTimes(2);
  });

  it("does not expose indexing exception details", async () => {
    const { handler, ingest } = setup();
    ingest.mockRejectedValueOnce(new Error("secret binding value"));
    const form = new FormData();
    form.append("file", new File(["# One"], "one.md"));

    const response = await handler(uploadRequest("/admin/api/knowledge", form));
    const body = await response.text();

    expect(response.status).toBe(422);
    expect(body).toContain("previous version was retained");
    expect(body).not.toContain("secret binding value");
  });
});
