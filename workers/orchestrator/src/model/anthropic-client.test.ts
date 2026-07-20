import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AnthropicModelClient,
  fromAnthropicMessage,
  toAnthropicMessages,
} from "./anthropic-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe("AnthropicModelClient", () => {
  it("sends the admin-selected model and effort", async () => {
    let sentBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        sentBody =
          input instanceof Request
            ? await input.clone().json()
            : (JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({
          id: "msg_3",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          content: [{ type: "text", text: "Done" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      }),
    );
    const client = new AnthropicModelClient(
      "anthropic-key",
      "claude-sonnet-5",
      "medium",
    );

    await client.createMessage({
      system: "You are Słones.",
      messages: [{ role: "user", content: "Hello" }],
      tools: [],
      signal: new AbortController().signal,
    });

    expect(sentBody).toMatchObject({
      model: "claude-sonnet-5",
      output_config: { effort: "medium" },
    });
  });
});
