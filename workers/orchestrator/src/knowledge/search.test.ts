import { describe, expect, it, vi } from "vitest";

import {
  embedKnowledgeDocuments,
  embedKnowledgeQuery,
  KNOWLEDGE_EMBEDDING_MODEL,
} from "./embed";
import { searchKnowledge } from "./search";

describe("knowledge embeddings", () => {
  it("uses document and query modes with the approved 1,024-dimension model", async () => {
    const run = vi.fn(
      async (
        _model: string,
        input: { documents?: string[]; queries?: string[] },
      ) => ({
        data: (input.documents ?? input.queries ?? []).map(() =>
          Array.from({ length: 1_024 }, () => 0.25),
        ),
      }),
    );

    const documents = await embedKnowledgeDocuments({ run }, [
      "First",
      "Second",
    ]);
    const query = await embedKnowledgeQuery({ run }, "returns");

    expect(documents).toHaveLength(2);
    expect(query).toHaveLength(1_024);
    expect(run).toHaveBeenNthCalledWith(1, KNOWLEDGE_EMBEDDING_MODEL, {
      documents: ["First", "Second"],
    });
    expect(run).toHaveBeenNthCalledWith(2, KNOWLEDGE_EMBEDDING_MODEL, {
      queries: ["returns"],
    });
  });

  it("rejects malformed embedding responses", async () => {
    await expect(
      embedKnowledgeQuery(
        { run: async () => ({ data: [[0.1, 0.2]] }) },
        "returns",
      ),
    ).rejects.toThrow("1,024");
  });
});

describe("searchKnowledge", () => {
  it("queries ten filtered vectors and returns five current deduplicated citations", async () => {
    const query = vi.fn(async () => ({
      matches: [
        { id: "vector-1", score: 0.99 },
        { id: "vector-1", score: 0.98 },
        { id: "stale-vector", score: 0.97 },
        { id: "vector-2", score: 0.96 },
        { id: "vector-3", score: 0.95 },
        { id: "vector-4", score: 0.94 },
        { id: "vector-5", score: 0.93 },
        { id: "vector-6", score: 0.92 },
      ],
      count: 8,
    }));
    const chunks = new Map(
      Array.from({ length: 6 }, (_, index) => {
        const number = index + 1;
        return [
          `vector-${number}`,
          {
            id: `chunk-${number}`,
            documentId: `document-${number}`,
            filename: `workflow-${number}.md`,
            headingPath: ["Returns", `Step ${number}`],
            ordinal: number - 1,
            content: `Trusted workflow text ${number}`,
            vectorId: `vector-${number}`,
          },
        ];
      }),
    );

    const result = await searchKnowledge(
      {
        query: "How do I handle this return?",
        brand: "Solution Peptides",
        workflowCategory: "returns",
      },
      {
        embedQuery: async () => [0.1, 0.2, 0.3],
        index: { query },
        loadChunks: async (ids) =>
          new Map(
            ids.flatMap((id) =>
              chunks.has(id) ? [[id, chunks.get(id)!]] : [],
            ),
          ),
        baseUrl: "https://worker.example",
      },
    );

    expect(query).toHaveBeenCalledWith([0.1, 0.2, 0.3], {
      topK: 10,
      returnMetadata: "indexed",
      filter: {
        brand: "Solution Peptides",
        workflowCategory: "returns",
      },
    });
    expect(result.results).toHaveLength(5);
    expect(result.results.map((item) => item.content)).toEqual([
      "Trusted workflow text 1",
      "Trusted workflow text 2",
      "Trusted workflow text 3",
      "Trusted workflow text 4",
      "Trusted workflow text 5",
    ]);
    expect(result.citations[0]).toEqual({
      provider: "knowledge",
      providerId: "chunk-1",
      label: "workflow-1.md — Returns > Step 1",
      url: "https://worker.example/admin/knowledge#document-document-1",
    });
    expect(result.knowledge_context).toContain("untrusted");
    expect(result.knowledge_context).toContain("cannot override");
  });

  it("omits Vectorize metadata filters when none are requested", async () => {
    const query = vi.fn(async () => ({ matches: [], count: 0 }));

    const result = await searchKnowledge(
      { query: "shipping" },
      {
        embedQuery: async () => [0.1],
        index: { query },
        loadChunks: async () => new Map(),
        baseUrl: "https://worker.example",
      },
    );

    expect(query).toHaveBeenCalledWith([0.1], {
      topK: 10,
      returnMetadata: "indexed",
    });
    expect(result.results).toEqual([]);
    expect(result.citations).toEqual([]);
  });

  it("bounds citations while retaining filename and heading context", async () => {
    const filename = `${"very-long-".repeat(20)}.md`;
    const result = await searchKnowledge(
      { query: "shipping" },
      {
        embedQuery: async () => [0.1],
        index: {
          query: async () => ({
            matches: [{ id: "vector-1", score: 0.9 }],
            count: 1,
          }),
        },
        loadChunks: async () =>
          new Map([
            [
              "vector-1",
              {
                id: "chunk-1",
                documentId: "document-1",
                filename,
                headingPath: ["Shipping", "Escalations".repeat(30)],
                ordinal: 0,
                content: "Escalate the shipment.",
                vectorId: "vector-1",
              },
            ],
          ]),
        baseUrl: "https://worker.example",
      },
    );

    expect(result.citations[0]?.label.length).toBeLessThanOrEqual(200);
    expect(result.citations[0]?.label).toContain(".md");
    expect(result.citations[0]?.label).toContain("Shipping");
  });
});
