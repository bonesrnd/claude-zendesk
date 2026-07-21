import {
  KnowledgeConflictError,
  KnowledgeNotFoundError,
  KnowledgeValidationError,
  type KnowledgeIndexMessage,
} from "../repositories/knowledge";

interface QueueMessageLike {
  body: unknown;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

interface QueueBatchLike {
  messages: readonly QueueMessageLike[];
}

interface KnowledgeQueueProcessor {
  processQueued(message: KnowledgeIndexMessage): Promise<unknown>;
}

function isKnowledgeIndexMessage(
  value: unknown,
): value is KnowledgeIndexMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "documentId" in value &&
    typeof value.documentId === "string" &&
    "versionId" in value &&
    typeof value.versionId === "string"
  );
}

export async function handleKnowledgeQueue(
  batch: QueueBatchLike,
  processor: KnowledgeQueueProcessor,
): Promise<void> {
  for (const message of batch.messages) {
    if (!isKnowledgeIndexMessage(message.body)) {
      message.ack();
      continue;
    }
    try {
      await processor.processQueued(message.body);
      message.ack();
    } catch (error) {
      if (
        error instanceof KnowledgeConflictError ||
        error instanceof KnowledgeNotFoundError ||
        error instanceof KnowledgeValidationError
      ) {
        message.ack();
        continue;
      }
      message.retry({
        delaySeconds: Math.min(30 * 2 ** message.attempts, 43_200),
      });
    }
  }
}
