export type ModelBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      toolUseId: string;
      content: unknown;
      isError: boolean;
    };

export interface ModelMessage {
  role: "user" | "assistant";
  content: string | ModelBlock[];
}

export interface ModelTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelResponse {
  blocks: ModelBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "pause_turn" | "refusal";
}

export interface ModelClient {
  createMessage(input: {
    system: string;
    messages: ModelMessage[];
    tools: ModelTool[];
    signal: AbortSignal;
  }): Promise<ModelResponse>;
}
