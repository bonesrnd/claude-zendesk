import Anthropic from "@anthropic-ai/sdk";
import type { AnthropicEffort } from "@resolve/contracts";

import type {
  ModelBlock,
  ModelClient,
  ModelMessage,
  ModelResponse,
} from "./model-client";

function serializeToolContent(content: unknown): string {
  if (typeof content === "string") return content;
  return JSON.stringify(content) ?? "null";
}

export function toAnthropicMessages(
  messages: readonly ModelMessage[],
): Anthropic.MessageParam[] {
  return messages.map((message) => ({
    role: message.role,
    content:
      typeof message.content === "string"
        ? message.content
        : message.content.map((block) => {
            if (block.type === "text") {
              return { type: "text", text: block.text };
            }
            if (block.type === "tool_use") {
              return {
                type: "tool_use",
                id: block.id,
                name: block.name,
                input: block.input,
              };
            }
            return {
              type: "tool_result",
              tool_use_id: block.toolUseId,
              content: serializeToolContent(block.content),
              is_error: block.isError,
            };
          }),
  }));
}

export function fromAnthropicMessage(
  message: Anthropic.Message,
): ModelResponse {
  const blocks = message.content.flatMap<ModelBlock>((block) => {
    if (block.type === "text") {
      return [{ type: "text", text: block.text }];
    }
    if (block.type === "tool_use") {
      return [
        {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        },
      ];
    }
    return [];
  });

  return {
    blocks,
    stopReason:
      message.stop_reason === "tool_use" ||
      message.stop_reason === "max_tokens" ||
      message.stop_reason === "pause_turn" ||
      message.stop_reason === "refusal"
        ? message.stop_reason
        : "end_turn",
  };
}

export class AnthropicModelClient implements ModelClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly effort: AnthropicEffort,
  ) {}

  async createMessage(
    input: Parameters<ModelClient["createMessage"]>[0],
  ): Promise<ModelResponse> {
    const client = new Anthropic({ apiKey: this.apiKey });
    const message = await client.messages.create(
      {
        model: this.model,
        max_tokens: 2_048,
        system: input.system,
        output_config: { effort: this.effort },
        messages: toAnthropicMessages(input.messages),
        tools: input.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
        })),
      },
      { signal: input.signal },
    );
    return fromAnthropicMessage(message);
  }
}
