import { authenticate } from "./http/auth";
import { errorResponse } from "./http/errors";
import { route } from "./http/router";
import { logger } from "./observability/logger";

function withRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-resolve-request-id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const requestId = `req_${crypto.randomUUID()}`;
    const startedAt = Date.now();
    const finalize = (response: Response) => {
      logger.info("request.completed", {
        requestId,
        durationMs: Date.now() - startedAt,
        httpStatus: response.status,
        status: response.ok ? "succeeded" : "failed",
      });
      return withRequestId(response, requestId);
    };
    if (!(await authenticate(request, env.BACKEND_AUTH_TOKEN))) {
      return finalize(
        errorResponse(401, "unauthorized", "Request is not authorized", false),
      );
    }

    const rateLimit = await env.REQUEST_LIMITER.limit({
      key: env.TENANT_KEY,
    });
    if (!rateLimit.success) {
      return finalize(
        errorResponse(
          429,
          "rate_limited",
          "Resolve is receiving too many requests. Try again shortly.",
          true,
        ),
      );
    }

    return finalize(await route(request, env));
  },
  scheduled(_controller, env, context): void {
    context.waitUntil(
      env.DB.batch([
        env.DB.prepare("DELETE FROM pending_turns WHERE expires_at <= ?").bind(
          new Date().toISOString(),
        ),
        env.DB.prepare("DELETE FROM conversations WHERE expires_at <= ?").bind(
          new Date().toISOString(),
        ),
      ]).then(() => undefined),
    );
  },
} satisfies ExportedHandler<Env>;
