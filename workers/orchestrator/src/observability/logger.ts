const REDACTED = "[REDACTED]";
const SENSITIVE_KEY =
  /(?:authorization|api[-_]?key|secret|token|message[-_]?body|prompt|content|(?:^|[-_])key)$/i;

export interface LogMetadata {
  requestId?: string;
  conversationId?: string;
  skillId?: string;
  toolName?: string;
  durationMs?: number;
  httpStatus?: number;
  status?: "started" | "succeeded" | "failed";
  safeErrorCode?: string;
}

export function redactForLog(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactForLog(item, seen));
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? REDACTED : redactForLog(item, seen),
    ]),
  );
}

const SAFE_ERROR_CODES = new Set([
  "unauthorized",
  "validation_error",
  "configuration_error",
  "integration_error",
  "rate_limited",
  "orchestration_limit",
  "persistence_error",
  "tool_failed",
]);

export function safeErrorCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    SAFE_ERROR_CODES.has(error.code)
  ) {
    return error.code;
  }
  return "unexpected_error";
}

export function createLogger(
  write: (line: string) => void = (line) => console.log(line),
) {
  const safeMetadata = (metadata: LogMetadata) =>
    redactForLog(metadata) as LogMetadata;

  return {
    info(event: string, metadata: LogMetadata): void {
      write(
        JSON.stringify({
          level: "info",
          event,
          timestamp: new Date().toISOString(),
          ...safeMetadata(metadata),
        }),
      );
    },
    error(event: string, metadata: LogMetadata): void {
      write(
        JSON.stringify({
          level: "error",
          event,
          timestamp: new Date().toISOString(),
          ...safeMetadata(metadata),
        }),
      );
    },
  };
}

export const logger = createLogger();
