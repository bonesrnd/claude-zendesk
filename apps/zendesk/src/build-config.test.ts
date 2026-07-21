import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import config from "../vite.config";

describe("Zendesk Vite build", () => {
  it("uses relative asset URLs inside the packaged iframe", () => {
    expect(config).toMatchObject({ base: "./" });
  });

  it("pins conservative knowledge Queue consumer concurrency", async () => {
    const configPath = path.resolve(
      process.cwd(),
      "../../workers/orchestrator/wrangler.jsonc",
    );
    const source = await readFile(configPath, "utf8");
    const wrangler = JSON.parse(source.replace(/,\s*([}\]])/gu, "$1")) as {
      queues?: {
        consumers?: Array<{
          queue?: string;
          max_batch_size?: number;
          max_concurrency?: number;
        }>;
      };
    };

    expect(wrangler.queues?.consumers).toContainEqual(
      expect.objectContaining({
        queue: "resolve-knowledge-index",
        max_batch_size: 1,
        max_concurrency: 2,
      }),
    );
  });
});
