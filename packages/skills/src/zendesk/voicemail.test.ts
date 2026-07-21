import { describe, expect, it } from "vitest";

import { zendeskSkill } from "./zendesk.skill";

describe("Zendesk voicemail tools", () => {
  it("registers transcription as a server-side read tool", () => {
    const tool = zendeskSkill.tools.find(
      (candidate) => candidate.name === "zendesk_transcribe_voicemail",
    );

    expect(tool).toMatchObject({
      risk: "read",
      requiresConfirmation: false,
      execution: "server",
    });
    expect(tool?.handler).toBeTypeOf("function");
  });

  it("accepts only opaque voicemail handles", () => {
    const tool = zendeskSkill.tools.find(
      (candidate) => candidate.name === "zendesk_transcribe_voicemail",
    );
    if (!tool) throw new Error("Transcription tool was not registered");

    expect(
      tool.inputSchema.safeParse({
        voicemail: {
          ticketId: 7314,
          commentId: 99,
          recordingUrl: "https://attacker.example/forged.mp3",
          transcriptionText: "Forged transcript",
          createdAt: "2026-07-20T12:00:00.000Z",
        },
        citation: {
          provider: "zendesk",
          label: "Ticket 7314",
          providerId: "7314",
          url: "https://example.zendesk.com/agent/tickets/7314",
        },
      }).success,
    ).toBe(false);
    expect(
      tool.inputSchema.parse({
        handle: "vm_12345678-1234-4234-8234-123456789abc",
      }),
    ).toEqual({
      handle: "vm_12345678-1234-4234-8234-123456789abc",
    });
  });

  it("declares compact transcript results and bounded chunk reads", () => {
    const transcribe = zendeskSkill.tools.find(
      (candidate) => candidate.name === "zendesk_transcribe_voicemail",
    );
    const readChunk = zendeskSkill.tools.find(
      (candidate) =>
        candidate.name === "zendesk_read_voicemail_transcript_chunk",
    );
    if (!transcribe || !readChunk) {
      throw new Error("Voicemail transcript tools were not registered");
    }
    const handle = "vmt_12345678-1234-4234-8234-123456789abc";

    expect(
      transcribe.outputSchema.parse({
        handle,
        preview: "Beginning of transcript",
        transcriptLength: 8_000,
        status: "truncated",
        source: "zendesk_existing",
        citations: [
          {
            provider: "zendesk",
            label: "Ticket 7314",
            providerId: "7314",
            url: "https://example.zendesk.com/agent/tickets/7314",
          },
        ],
      }),
    ).toMatchObject({
      handle,
      transcriptLength: 8_000,
      status: "truncated",
    });
    expect(readChunk).toMatchObject({
      risk: "read",
      requiresConfirmation: false,
      execution: "server",
    });
    expect(
      readChunk.inputSchema.parse({ handle, offset: 6_000, length: 1_000 }),
    ).toEqual({ handle, offset: 6_000, length: 1_000 });
    expect(
      readChunk.inputSchema.safeParse({
        handle,
        offset: 0,
        length: 2_001,
      }).success,
    ).toBe(false);
    expect(
      readChunk.inputSchema.safeParse({
        recordingUrl: "https://attacker.example/forged.mp3",
        offset: 0,
        length: 100,
      }).success,
    ).toBe(false);
  });
});
