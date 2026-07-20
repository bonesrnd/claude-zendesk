import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SkillIdSchema = /^[a-z][a-z0-9-]*$/;

function skillVariable(id: string): string {
  return `${id.replace(/-([a-z0-9])/g, (_, character: string) =>
    character.toUpperCase(),
  )}Skill`;
}

function skillSource(id: string): string {
  const runtimeId = id.replaceAll("-", "_");
  const variable = skillVariable(id);
  return `import { defineSkill } from "@resolve/skill-sdk";

export const ${variable} = defineSkill({
  id: "${runtimeId}",
  name: "${id}",
  version: "1.0.0",
  instructions: "Use this skill only for ${id} requests.",
  credentials: [],
  tools: [],
});
`;
}

function testSource(id: string): string {
  const variable = skillVariable(id);
  return `import { describe, expect, it } from "vitest";

import { ${variable} } from "./${id}.skill";

describe("${id} skill", () => {
  it("defines at least one reviewed tool", () => {
    expect(${variable}.tools.length).toBeGreaterThan(0);
  });
});
`;
}

export async function scaffoldSkill(
  workspaceRoot: string,
  id: string,
): Promise<string[]> {
  if (!SkillIdSchema.test(id)) {
    throw new Error(
      "Skill id must use lowercase letters, numbers, and hyphens",
    );
  }

  const directory = resolve(workspaceRoot, "packages", "skills", "src", id);
  await mkdir(resolve(directory, "fixtures"), { recursive: true });

  const files = [
    {
      path: resolve(directory, `${id}.skill.ts`),
      content: skillSource(id),
    },
    {
      path: resolve(directory, `${id}.test.ts`),
      content: testSource(id),
    },
    {
      path: resolve(directory, "index.ts"),
      content: `export * from "./${id}.skill";\n`,
    },
  ];

  await Promise.all(
    files.map((file) =>
      writeFile(file.path, file.content, { encoding: "utf8", flag: "wx" }),
    ),
  );
  return files.map((file) => file.path);
}

async function main() {
  const id = process.argv[2];
  if (!id) {
    throw new Error("Usage: pnpm skills:new <skill-id>");
  }
  const files = await scaffoldSkill(process.cwd(), id);
  for (const file of files) console.log(file);
  console.log(
    "Review the generated skill, make its test pass, then register it explicitly.",
  );
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  await main();
}
