import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scaffoldSkill } from "./create-skill.mts";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(
    created.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("scaffoldSkill", () => {
  it("creates a reviewed skill skeleton without registering it", async () => {
    const root = await mkdtemp(join(tmpdir(), "resolve-skill-"));
    created.push(root);

    const files = await scaffoldSkill(root, "inventory");

    expect(files).toHaveLength(3);
    await expect(
      readFile(
        join(
          root,
          "packages",
          "skills",
          "src",
          "inventory",
          "inventory.skill.ts",
        ),
        "utf8",
      ),
    ).resolves.toContain('id: "inventory"');
    await expect(
      readFile(join(root, "packages", "skills", "src", "registry.ts"), "utf8"),
    ).rejects.toThrow();
  });

  it("rejects unsafe identifiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "resolve-skill-"));
    created.push(root);

    await expect(scaffoldSkill(root, "../escape")).rejects.toThrow(
      "Skill id must use lowercase letters, numbers, and hyphens",
    );
  });
});
