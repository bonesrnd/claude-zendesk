import { z } from "zod";

import {
  handleConversationMessages,
  handleTicketConversations,
} from "../routes/history";
import { handleSkillHealth, handleSkills } from "../routes/skills";
import { handleContinueTurn, handleTurn } from "../routes/turn";
import { errorResponse } from "./errors";
import { JsonRequestError } from "./json";

function tenantMatches(request: Request, env: Env): boolean {
  return request.headers.get("x-resolve-tenant")?.trim() === env.TENANT_KEY;
}

function wooOriginMatches(request: Request, env: Env): boolean {
  const requested = request.headers.get("x-resolve-woo-url")?.trim();
  if (!requested) return true;
  try {
    const requestedUrl = new URL(requested);
    const pinnedUrl = new URL(env.WOO_BASE_URL);
    return (
      requestedUrl.protocol === "https:" &&
      pinnedUrl.protocol === "https:" &&
      requestedUrl.origin === pinnedUrl.origin
    );
  } catch {
    return false;
  }
}

export async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (request.method === "GET" && pathname === "/health") {
    return Response.json({
      ok: true,
      service: "resolve-orchestrator",
    });
  }

  try {
    if (pathname.startsWith("/v1/") && !wooOriginMatches(request, env)) {
      return errorResponse(
        403,
        "unauthorized",
        "WooCommerce origin does not match the Worker configuration.",
        false,
      );
    }
    if (request.method === "POST" && pathname === "/v1/turn") {
      if (!tenantMatches(request, env)) {
        return errorResponse(
          403,
          "unauthorized",
          "Tenant is not authorized.",
          false,
        );
      }
      return await handleTurn(request, env);
    }
    if (request.method === "POST" && pathname === "/v1/turn/continue") {
      if (!tenantMatches(request, env)) {
        return errorResponse(
          403,
          "unauthorized",
          "Tenant is not authorized.",
          false,
        );
      }
      return await handleContinueTurn(request, env);
    }
    if (request.method === "GET" && pathname === "/v1/skills") {
      if (!tenantMatches(request, env)) {
        return errorResponse(
          403,
          "unauthorized",
          "Tenant is not authorized.",
          false,
        );
      }
      return handleSkills(request, env);
    }

    const healthMatch = pathname.match(
      /^\/v1\/skills\/([a-z][a-z0-9_]*)\/health$/,
    );
    if (request.method === "POST" && healthMatch?.[1]) {
      if (!tenantMatches(request, env)) {
        return errorResponse(
          403,
          "unauthorized",
          "Tenant is not authorized.",
          false,
        );
      }
      return await handleSkillHealth(request, env, healthMatch[1]);
    }

    const ticketHistoryMatch = pathname.match(
      /^\/v1\/tickets\/([^/]+)\/conversations$/,
    );
    if (request.method === "GET" && ticketHistoryMatch?.[1]) {
      if (!tenantMatches(request, env)) {
        return errorResponse(
          403,
          "unauthorized",
          "Tenant is not authorized.",
          false,
        );
      }
      return await handleTicketConversations(
        request,
        env,
        ticketHistoryMatch[1],
      );
    }

    const messagesMatch = pathname.match(
      /^\/v1\/conversations\/([^/]+)\/messages$/,
    );
    if (request.method === "GET" && messagesMatch?.[1]) {
      if (!tenantMatches(request, env)) {
        return errorResponse(
          403,
          "unauthorized",
          "Tenant is not authorized.",
          false,
        );
      }
      return await handleConversationMessages(request, env, messagesMatch[1]);
    }
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof JsonRequestError) {
      return errorResponse(
        400,
        "validation_error",
        "Request validation failed.",
        false,
      );
    }
    return errorResponse(
      502,
      "integration_error",
      "Resolve could not complete the request.",
      true,
    );
  }

  return errorResponse(
    404,
    "validation_error",
    "The requested route does not exist",
    false,
  );
}
