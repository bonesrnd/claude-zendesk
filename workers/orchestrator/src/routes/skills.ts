import { skillRegistry } from "@resolve/skills";
import { z } from "zod";

import { readCredentials } from "../http/credentials";
import { errorResponse } from "../http/errors";
import { readJsonBody } from "../http/json";

const HealthRequestSchema = z.strictObject({
  ticketId: z.number().int().positive(),
});

function skillIsConfigured(
  skill: (typeof skillRegistry.skills)[number],
  headers: Headers,
  env: Env,
): boolean {
  const credentials = {
    ...readCredentials(headers, { wooBaseUrl: env.WOO_BASE_URL }),
  };
  if (skill.isConfigured) return skill.isConfigured(credentials);
  return skill.credentials
    .filter((credential) => credential.required)
    .every((credential) => Boolean(headers.get(credential.headerName)));
}

export function handleSkills(request: Request, env: Env): Response {
  return Response.json({
    skills: skillRegistry.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      version: skill.version,
      configured: skillIsConfigured(skill, request.headers, env),
      tools: skill.tools.map((tool) => ({
        name: tool.name,
        risk: tool.risk,
      })),
    })),
  });
}

export async function handleSkillHealth(
  request: Request,
  env: Env,
  skillId: string,
): Promise<Response> {
  const skill = skillRegistry.skills.find(
    (candidate) => candidate.id === skillId,
  );
  if (!skill) {
    return errorResponse(
      404,
      "validation_error",
      "Skill was not found.",
      false,
    );
  }
  if (!skillIsConfigured(skill, request.headers, env)) {
    return errorResponse(
      400,
      "configuration_error",
      `${skill.name} is not configured.`,
      false,
      skill.id,
    );
  }
  const body = HealthRequestSchema.parse(await readJsonBody(request));
  if (!skill.healthCheck) {
    return Response.json({
      id: skill.id,
      ok: true,
      message: `${skill.name} is ready.`,
    });
  }

  try {
    const result = await skill.healthCheck({
      signal: request.signal,
      credentials: {
        ...readCredentials(request.headers, {
          wooBaseUrl: env.WOO_BASE_URL,
        }),
      },
      tenantKey: request.headers.get("x-resolve-tenant")?.trim() ?? "",
      ticketId: body.ticketId,
    });
    return Response.json({ id: skill.id, ...result });
  } catch (error) {
    const code =
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "configuration_error"
        ? "configuration_error"
        : "integration_error";
    return errorResponse(
      code === "configuration_error" ? 400 : 502,
      code,
      `${skill.name} health check failed.`,
      code !== "configuration_error",
      skill.id,
    );
  }
}
