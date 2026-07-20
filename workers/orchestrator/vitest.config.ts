import path from "node:path";

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

process.env.BACKEND_AUTH_TOKEN = "test-backend-token";
process.env.TENANT_KEY = "test-tenant";
process.env.WOO_BASE_URL = "https://store.example";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            path.join(import.meta.dirname, "migrations"),
          ),
          BACKEND_AUTH_TOKEN: "test-backend-token",
          TENANT_KEY: "test-tenant",
          WOO_BASE_URL: "https://store.example",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
