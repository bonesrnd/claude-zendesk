import { afterEach, describe, expect, it, vi } from "vitest";

import * as transcription from "./transcription";

const voicemailInput = {
  kind: "zendesk_voicemail" as const,
  voicemail: {
    ticketId: 7314,
    commentId: 99,
    recordingUrl: "https://recordings.example/99.mp3",
    transcriptionText: "",
    createdAt: "2026-07-20T12:00:00.000Z",
  },
  citation: {
    provider: "zendesk" as const,
    label: "Ticket 7314",
    providerId: "7314",
    url: "https://example.zendesk.com/agent/tickets/7314",
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("transcribeAudio", () => {
  it("uses Whisper Large v3 Turbo through the Workers AI binding", async () => {
    const run = vi.fn().mockResolvedValue({
      text: "Please call me back.",
      segments: [
        {
          text: "Please call me back.",
          start: 0,
          end: 1.5,
        },
      ],
      transcription_info: {
        language: "en",
        duration: 1.5,
      },
    });
    const ai = { run } as unknown as Ai;

    const result = await transcription.transcribeAudio(
      new Uint8Array([0x49, 0x44, 0x33, 0x04]),
      "audio/mpeg",
      ai,
      new AbortController().signal,
    );

    expect(run).toHaveBeenCalledWith(
      "@cf/openai/whisper-large-v3-turbo",
      { audio: "SUQzBA==" },
      expect.any(Object),
    );
    expect(result).toEqual({
      text: "Please call me back.",
      language: "en",
      segments: [
        {
          text: "Please call me back.",
          startSecond: 0,
          endSecond: 1.5,
        },
      ],
    });
  });

  it("cancels Workers AI inference when the turn signal aborts", async () => {
    const controller = new AbortController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const run = vi
      .fn()
      .mockImplementation(
        (
          _model: string,
          _inputs: unknown,
          options?: { signal?: AbortSignal },
        ) => {
          markStarted?.();
          if (!options?.signal) {
            return Promise.reject(new Error("Missing AI abort signal"));
          }
          return new Promise((_resolve, reject) => {
            options.signal?.addEventListener(
              "abort",
              () => {
                const reason = options.signal?.reason;
                reject(
                  reason instanceof Error
                    ? reason
                    : new DOMException("Inference aborted", "AbortError"),
                );
              },
              { once: true },
            );
          });
        },
      );

    const pending = transcription.transcribeAudio(
      new Uint8Array([0x49, 0x44, 0x33, 0x04]),
      "audio/mpeg",
      { run } as unknown as Ai,
      controller.signal,
    );
    await started;
    controller.abort(new DOMException("Turn timed out", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("exposes the voicemail transcription handler", () => {
    expect(transcription).toHaveProperty(
      "transcribeVoicemail",
      expect.any(Function),
    );
  });

  it("falls back to an existing Zendesk transcript when Workers AI is unavailable", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("Recording fetch unavailable"));
    vi.stubGlobal("fetch", fetchMock);
    const run = vi.fn().mockRejectedValue(new Error("Workers AI unavailable"));

    const result = await transcription.transcribeVoicemail(
      {
        ...voicemailInput,
        voicemail: {
          ...voicemailInput.voicemail,
          transcriptionText: "  Please call me back.  ",
        },
      },
      new AbortController().signal,
      { run } as unknown as Ai,
    );

    expect(result).toEqual({
      kind: "zendesk_voicemail_transcript",
      text: "Please call me back.",
      source: "zendesk_existing",
      citations: [voicemailInput.citation],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("fetches and transcribes voicemail audio without returning bytes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04]), {
          headers: { "content-type": "audio/mpeg" },
        }),
      ),
    );
    const run = vi.fn().mockResolvedValue({
      text: "Please call me back.",
      segments: [
        {
          text: "Please call me back.",
          start: 0,
          end: 1.5,
        },
      ],
      transcription_info: {
        language: "en",
        duration: 1.5,
      },
    });

    const result = await transcription.transcribeVoicemail(
      voicemailInput,
      new AbortController().signal,
      { run } as unknown as Ai,
    );

    expect(result).toEqual({
      kind: "zendesk_voicemail_transcript",
      text: "Please call me back.",
      language: "en",
      segments: [
        {
          text: "Please call me back.",
          startSecond: 0,
          endSecond: 1.5,
        },
      ],
      source: "cloudflare_workers_ai",
      citations: [voicemailInput.citation],
    });
    expect(result).not.toHaveProperty("audio");
    expect(result).not.toHaveProperty("bytes");
  });

  it("retains a complete transcript and reads a later bounded chunk", () => {
    const text = `${"A".repeat(6_500)} LATE_MARKER ${"B".repeat(1_000)}`;
    let retained: unknown;
    const compact = transcription.retainVoicemailTranscript(
      {
        kind: "zendesk_voicemail_transcript",
        text,
        source: "zendesk_existing",
        citations: [voicemailInput.citation],
      },
      (_handle, value) => {
        retained = value;
      },
    );

    expect(compact).toMatchObject({
      handle: expect.stringMatching(/^vmt_/),
      preview: "A".repeat(1_000),
      transcriptLength: text.length,
      status: "truncated",
      source: "zendesk_existing",
    });
    expect(compact).not.toHaveProperty("text");
    expect(retained).toMatchObject({ text });

    const chunk = transcription.readVoicemailTranscriptChunk(
      {
        handle: compact.handle,
        offset: 6_400,
        length: 300,
      },
      retained,
    );
    expect(chunk.text).toContain("LATE_MARKER");
    expect(chunk.status).toBe("more");
    expect(() =>
      transcription.readVoicemailTranscriptChunk(
        {
          handle: compact.handle,
          offset: text.length,
          length: 100,
        },
        retained,
      ),
    ).toThrow("outside");
  });
});
