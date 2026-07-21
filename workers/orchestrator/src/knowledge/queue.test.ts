import { describe, expect, it, vi } from "vitest";

import { KnowledgeConflictError } from "../repositories/knowledge";
import { handleKnowledgeQueue } from "./queue";

function message(body: unknown, attempts = 1) {
  return {
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

describe("handleKnowledgeQueue", () => {
  it("processes and acknowledges one document message", async () => {
    const queued = message({
      documentId: "doc_123",
      versionId: "ver_123",
    });
    const processQueued = vi.fn(async () => undefined);

    await handleKnowledgeQueue({ messages: [queued] }, { processQueued });

    expect(processQueued).toHaveBeenCalledOnce();
    expect(processQueued).toHaveBeenCalledWith({
      documentId: "doc_123",
      versionId: "ver_123",
    });
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
  });

  it("retries transient indexing failures with bounded backoff", async () => {
    const queued = message({ documentId: "doc_123", versionId: "ver_123" }, 3);
    const processQueued = vi.fn(async () => {
      throw new Error("synthetic indexing failure");
    });

    await handleKnowledgeQueue({ messages: [queued] }, { processQueued });

    expect(queued.ack).not.toHaveBeenCalled();
    expect(queued.retry).toHaveBeenCalledWith({ delaySeconds: 240 });
  });

  it("acknowledges terminal CAS conflicts without retrying", async () => {
    const queued = message({
      documentId: "doc_123",
      versionId: "ver_123",
    });
    const processQueued = vi.fn(async () => {
      throw new KnowledgeConflictError();
    });

    await handleKnowledgeQueue({ messages: [queued] }, { processQueued });

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
  });
});
