import { ErrorResponseSchema, type ErrorResponse } from "@resolve/contracts";

export type PublicErrorCode = ErrorResponse["code"];

export function errorResponse(
  status: number,
  code: PublicErrorCode,
  message: string,
  retryable: boolean,
  integration?: string,
  partial?: ErrorResponse["partial"],
): Response {
  const body = ErrorResponseSchema.parse({
    kind: "error",
    code,
    message,
    retryable,
    ...(integration ? { integration } : {}),
    ...(partial ? { partial } : {}),
  });

  return Response.json(body, { status });
}
