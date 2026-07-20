import { describe, expect, it } from "vitest";

import { authenticate } from "./auth";

describe("authenticate", () => {
  it("rejects a missing bearer token", async () => {
    await expect(
      authenticate(new Request("https://worker.test/health"), "expected"),
    ).resolves.toBe(false);
  });

  it("rejects the wrong bearer token", async () => {
    await expect(
      authenticate(
        new Request("https://worker.test/health", {
          headers: { authorization: "Bearer wrong" },
        }),
        "expected",
      ),
    ).resolves.toBe(false);
  });

  it("accepts the expected bearer token", async () => {
    await expect(
      authenticate(
        new Request("https://worker.test/health", {
          headers: { authorization: "Bearer expected" },
        }),
        "expected",
      ),
    ).resolves.toBe(true);
  });
});
