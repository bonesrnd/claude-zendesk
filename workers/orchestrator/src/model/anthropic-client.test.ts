import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import { fromAnthropicMessage, toAnthropicMessages } from "./anthropic-client";

describe("Anthropic message conversion", () => {
  it("preserves tool result identifiers", () => {
    expect(
      toAnthropicMessages([
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "tool_1",
              content: { status: "processing" },
              isError: false,
            },
          ],
        },
      ]),
    ).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_1",
            content: '{"status":"processing"}',
            is_error: false,
          },
        ],
      },
    ]);
  });

  it("maps Anthropic tool use into provider-neutral blocks", () => {
    const message = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5-20250929",
      content: [
        { type: "text", text: "I will check." },
        {
          type: "tool_use",
          id: "tool_1",
          name: "server_read",
          input: { id: "10982" },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    } as Anthropic.Message;

    expect(fromAnthropicMessage(message)).toEqual({
      stopReason: "tool_use",
      blocks: [
        { type: "text", text: "I will check." },
        {
          type: "tool_use",
          id: "tool_1",
          name: "server_read",
          input: { id: "10982" },
        },
      ],
    });
  });

  it("preserves token exhaustion instead of reporting a completed turn", () => {
    const message = {
      id: "msg_2",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5-20250929",
      content: [{ type: "text", text: "A truncated answer" }],
      stop_reason: "max_tokens",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2048 },
    } as Anthropic.Message;

    expect(fromAnthropicMessage(message)).toMatchObject({
      stopReason: "max_tokens",
    });
  });
});
