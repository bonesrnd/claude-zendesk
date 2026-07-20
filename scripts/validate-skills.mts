import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  SkillDefinition,
  SkillCredential,
} from "../packages/skill-sdk/src/index";
import { SkillRegistry } from "../packages/skill-sdk/src/index";
import { skills } from "../packages/skills/src/registry";

interface ManifestParameter {
  name: string;
  type: string;
  secure?: boolean;
  scopes?: string[];
}

interface ZendeskManifest {
  parameters?: ManifestParameter[];
}

function validateCredential(
  skill: SkillDefinition,
  credential: SkillCredential,
  parameter: ManifestParameter | undefined,
): string[] {
  if (!parameter) {
    return [
      `Skill ${skill.id} references missing setting ${credential.settingName}`,
    ];
  }
  if (!credential.secret) return [];
  if (!parameter.secure) {
    return [`Setting ${credential.settingName} must be secure`];
  }
  if (parameter.scopes?.length !== 1 || parameter.scopes[0] !== "header") {
    return [
      `Secure setting ${credential.settingName} must declare scopes: ["header"]`,
    ];
  }
  return [];
}

export function validateCredentialManifest(
  definitions: readonly SkillDefinition[],
  manifest: ZendeskManifest,
): string[] {
  const parameters = new Map(
    (manifest.parameters ?? []).map((parameter) => [parameter.name, parameter]),
  );

  return definitions.flatMap((skill) =>
    skill.credentials.flatMap((credential) =>
      validateCredential(
        skill,
        credential,
        parameters.get(credential.settingName),
      ),
    ),
  );
}

async function loadManifest(): Promise<ZendeskManifest | undefined> {
  try {
    return JSON.parse(
      await readFile(resolve("apps/zendesk/zendesk/manifest.json"), "utf8"),
    ) as ZendeskManifest;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function validateSkills(): Promise<string[]> {
  new SkillRegistry(skills);
  const manifest = await loadManifest();
  const credentialCount = skills.reduce(
    (total, skill) => total + skill.credentials.length,
    0,
  );
  if (!manifest) {
    return credentialCount === 0
      ? []
      : ["Zendesk manifest is missing; credential settings cannot be verified"];
  }
  return validateCredentialManifest(skills, manifest);
}

async function main() {
  const errors = await validateSkills();
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  console.log(`Validated ${skills.length} skill pack(s).`);
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  await main();
}
