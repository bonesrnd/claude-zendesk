export const KNOWLEDGE_EMBEDDING_MODEL =
  "@cf/qwen/qwen3-embedding-0.6b" as const;
export const KNOWLEDGE_EMBEDDING_DIMENSIONS = 1_024;

const EMBEDDING_BATCH_SIZE = 32;

interface KnowledgeAiBinding {
  run(
    model: typeof KNOWLEDGE_EMBEDDING_MODEL,
    input: { documents?: string[]; queries?: string[] },
  ): Promise<unknown>;
}

interface EmbeddingResponse {
  data?: unknown;
}

function validateEmbeddings(
  response: unknown,
  expectedCount: number,
): number[][] {
  const data =
    response && typeof response === "object" && "data" in response
      ? (response as EmbeddingResponse).data
      : undefined;
  if (
    !Array.isArray(data) ||
    data.length !== expectedCount ||
    !data.every(
      (embedding) =>
        Array.isArray(embedding) &&
        embedding.length === KNOWLEDGE_EMBEDDING_DIMENSIONS &&
        embedding.every(
          (value) => typeof value === "number" && Number.isFinite(value),
        ),
    )
  ) {
    throw new Error(
      "Knowledge embeddings must contain one 1,024-dimension vector per input.",
    );
  }
  return data as number[][];
}

export async function embedKnowledgeDocuments(
  ai: KnowledgeAiBinding,
  documents: readonly string[],
): Promise<number[][]> {
  const embeddings: number[][] = [];
  for (let index = 0; index < documents.length; index += EMBEDDING_BATCH_SIZE) {
    const batch = documents.slice(index, index + EMBEDDING_BATCH_SIZE);
    const response = await ai.run(KNOWLEDGE_EMBEDDING_MODEL, {
      documents: batch,
    });
    embeddings.push(...validateEmbeddings(response, batch.length));
  }
  return embeddings;
}

export async function embedKnowledgeQuery(
  ai: KnowledgeAiBinding,
  query: string,
): Promise<number[]> {
  const response = await ai.run(KNOWLEDGE_EMBEDDING_MODEL, {
    queries: [query],
  });
  return validateEmbeddings(response, 1)[0]!;
}
