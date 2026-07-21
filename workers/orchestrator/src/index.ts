import { verifyAccessRequest } from "./admin/access";
import { authenticate } from "./http/auth";
import { errorResponse } from "./http/errors";
import { route } from "./http/router";
import { embedKnowledgeDocuments } from "./knowledge/embed";
import { handleKnowledgeQueue } from "./knowledge/queue";
import { logger } from "./observability/logger";
import { KnowledgeRepository } from "./repositories/knowledge";
import { handleKnowledgeAdmin } from "./routes/knowledge-admin";

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
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith("/admin/")) {
      const access = await verifyAccessRequest(request, {
        teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
        audience: env.CF_ACCESS_AUD,
      });
      if (!access.ok) {
        return finalize(
          errorResponse(
            401,
            "unauthorized",
            "Cloudflare Access authorization is required.",
            false,
          ),
        );
      }
      try {
        return finalize(await handleKnowledgeAdmin(request, env));
      } catch {
        return finalize(
          errorResponse(
            502,
            "integration_error",
            "Knowledge administration could not complete the request.",
            true,
          ),
        );
      }
    }
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
          "Słones is receiving too many requests. Try again shortly.",
          true,
        ),
      );
    }

    return finalize(await route(request, env));
  },
  scheduled(_controller, env, context): void {
    context.waitUntil(
      env.DB.batch([
        env.DB.prepare(
          "DELETE FROM write_proposals WHERE expires_at <= ?",
        ).bind(new Date().toISOString()),
        env.DB.prepare("DELETE FROM pending_turns WHERE expires_at <= ?").bind(
          new Date().toISOString(),
        ),
        env.DB.prepare("DELETE FROM conversations WHERE expires_at <= ?").bind(
          new Date().toISOString(),
        ),
      ]).then(() => undefined),
    );
  },
  queue(batch, env): Promise<void> {
    return handleKnowledgeQueue(
      batch,
      new KnowledgeRepository({
        db: env.DB,
        bucket: env.KNOWLEDGE_BUCKET,
        index: env.KNOWLEDGE_INDEX,
        embedDocuments: (documents) =>
          embedKnowledgeDocuments(env.AI, documents),
      }),
    );
  },
} satisfies ExportedHandler<Env>;
