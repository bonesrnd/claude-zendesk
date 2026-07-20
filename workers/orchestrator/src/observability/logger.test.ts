import { describe, expect, it, vi } from "vitest";

import { createLogger, redactForLog, safeErrorCode } from "./logger";

describe("redactForLog", () => {
  it("removes credentials and customer content recursively", () => {
    expect(
      redactForLog({
        requestId: "req_1",
        headers: {
          authorization: "Bearer secret",
          "api-key": "ship-secret",
          "x-resolve-woo-key": "woo-secret",
        },
        nested: {
          backendToken: "backend-secret",
          messageBody: "customer message",
          durationMs: 42,
        },
      }),
    ).toEqual({
      requestId: "req_1",
      headers: {
        authorization: "[REDACTED]",
        "api-key": "[REDACTED]",
        "x-resolve-woo-key": "[REDACTED]",
      },
      nested: {
        backendToken: "[REDACTED]",
        messageBody: "[REDACTED]",
        durationMs: 42,
      },
    });
  });
});

describe("createLogger", () => {
  it("emits structured JSON with safe operational fields", () => {
    const write = vi.fn();
    const logger = createLogger(write);

    logger.info("tool.completed", {
      requestId: "req_1",
      conversationId: "conv_1",
      skillId: "woocommerce",
      toolName: "woocommerce_get_order",
      durationMs: 42,
      status: "succeeded",
    });

    expect(JSON.parse(write.mock.calls[0]?.[0] ?? "")).toMatchObject({
      level: "info",
      event: "tool.completed",
      requestId: "req_1",
      durationMs: 42,
    });
  });
});

describe("safeErrorCode", () => {
  it("maps unknown thrown values without serializing them", () => {
    expect(safeErrorCode(new Error("contains a secret"))).toBe(
      "unexpected_error",
    );
    expect(safeErrorCode({ code: "rate_limited", detail: "secret" })).toBe(
      "rate_limited",
    );
  });
});
