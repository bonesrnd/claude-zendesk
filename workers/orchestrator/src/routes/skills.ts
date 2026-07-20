import { TicketBrandSchema } from "@resolve/contracts";
import { skillRegistry } from "@resolve/skills";
import { z } from "zod";

import {
  readCredentials,
  resolveWooStoreForBrand,
  wooCredentialSourceForStore,
  type WooStoreKey,
} from "../http/credentials";
import { errorResponse } from "../http/errors";
import { readJsonBody } from "../http/json";

const HealthRequestSchema = z.strictObject({
  ticketId: z.number().int().positive(),
  brand: TicketBrandSchema,
});

const WOO_CONNECTIONS: Array<{
  id: WooStoreKey;
  name: string;
}> = [
  { id: "solution_peptides", name: "Solution Peptides" },
  { id: "atomik_labz", name: "Atomik Labz" },
];

function credentialsForStore(headers: Headers, env: Env, store: WooStoreKey) {
  return {
    ...readCredentials(headers, wooCredentialSourceForStore(store, env)),
  };
}

function skillIsConfigured(
  skill: (typeof skillRegistry.skills)[number],
  headers: Headers,
  env: Env,
): boolean {
  if (skill.id === "woocommerce") {
    return WOO_CONNECTIONS.every(({ id }) =>
      skill.isConfigured?.(credentialsForStore(headers, env, id)),
    );
  }
  const credentials = { ...readCredentials(headers) };
  if (skill.isConfigured) return skill.isConfigured(credentials);
  return skill.credentials
    .filter((credential) => credential.required)
    .every((credential) => Boolean(headers.get(credential.headerName)));
}

function skillConnections(
  skill: (typeof skillRegistry.skills)[number],
  headers: Headers,
  env: Env,
) {
  if (skill.id !== "woocommerce") return undefined;
  return WOO_CONNECTIONS.map((connection) => ({
    ...connection,
    configured:
      skill.isConfigured?.(credentialsForStore(headers, env, connection.id)) ??
      false,
  }));
}

export function handleSkills(request: Request, env: Env): Response {
  return Response.json({
    skills: skillRegistry.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      version: skill.version,
      configured: skillIsConfigured(skill, request.headers, env),
      ...(skillConnections(skill, request.headers, env)
        ? {
            connections: skillConnections(skill, request.headers, env),
          }
        : {}),
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
  const body = HealthRequestSchema.parse(await readJsonBody(request));
  const wooStore =
    skill.id === "woocommerce"
      ? resolveWooStoreForBrand(body.brand)
      : undefined;
  if (skill.id === "woocommerce" && !wooStore) {
    return errorResponse(
      400,
      "configuration_error",
      `Brand ${body.brand.name} is not mapped to a WooCommerce store.`,
      false,
      skill.id,
    );
  }
  const credentials = wooStore
    ? credentialsForStore(request.headers, env, wooStore)
    : { ...readCredentials(request.headers) };
  const configured = skill.isConfigured
    ? skill.isConfigured(credentials)
    : skill.credentials
        .filter((credential) => credential.required)
        .every((credential) =>
          Boolean(request.headers.get(credential.headerName)),
        );
  if (!configured) {
    return errorResponse(
      400,
      "configuration_error",
      `${skill.name} is not configured.`,
      false,
      skill.id,
    );
  }
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
      credentials,
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
