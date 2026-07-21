import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_AUDIO_BYTES, fetchBoundedAudio } from "./audio-fetch";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fetchBoundedAudio", () => {
  it("rejects non-HTTPS recording URLs before fetching", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchBoundedAudio(
        "http://recordings.example/99.mp3",
        new AbortController().signal,
      ),
    ).rejects.toThrow("HTTPS");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "https://127.0.0.1/voice.mp3",
    "https://10.0.0.8/voice.mp3",
    "https://172.16.0.8/voice.mp3",
    "https://192.168.0.8/voice.mp3",
    "https://169.254.10.8/voice.mp3",
    "https://[::1]/voice.mp3",
    "https://[::ffff:127.0.0.1]/voice.mp3",
    "https://[fe80::1]/voice.mp3",
    "https://[fd00::1]/voice.mp3",
  ])("rejects private address literal %s", async (url) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchBoundedAudio(url, new AbortController().signal),
    ).rejects.toThrow("public");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects more than three redirects", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      const redirectNumber = fetchMock.mock.calls.length;
      return new Response(null, {
        status: 302,
        headers: {
          location: `https://recordings.example/${redirectNumber}.mp3`,
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchBoundedAudio(
        "https://recordings.example/start.mp3",
        new AbortController().signal,
      ),
    ).rejects.toThrow("redirect");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("rejects audio larger than 25 MB", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(null, {
          headers: {
            "content-length": String(MAX_AUDIO_BYTES + 1),
            "content-type": "audio/mpeg",
          },
        }),
      ),
    );

    await expect(
      fetchBoundedAudio(
        "https://recordings.example/large.mp3",
        new AbortController().signal,
      ),
    ).rejects.toThrow("25 MB");
  });

  it("rejects non-audio response media types", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response("not audio", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      ),
    );

    await expect(
      fetchBoundedAudio(
        "https://recordings.example/not-audio",
        new AbortController().signal,
      ),
    ).rejects.toThrow("audio");
  });

  it("fetches audio without forwarding authorization", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_input, init) => {
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        expect(init).toMatchObject({ redirect: "manual" });
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "audio/mpeg; charset=binary" },
        });
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchBoundedAudio(
        "https://recordings.example/99.mp3",
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "audio/mpeg",
    });
  });

  it("combines an internal timeout with the caller signal", async () => {
    const timeout = new AbortController();
    timeout.abort(new DOMException("Timed out", "TimeoutError"));
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeout.signal);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_input, init) => {
        expect(init?.signal?.aborted).toBe(true);
        throw init?.signal?.reason;
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchBoundedAudio(
        "https://recordings.example/slow.mp3",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(timeoutSpy).toHaveBeenCalledOnce();
  });
});
