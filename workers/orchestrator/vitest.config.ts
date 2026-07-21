import path from "node:path";

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

process.env.BACKEND_AUTH_TOKEN = "test-backend-token";
process.env.TENANT_KEY = "test-tenant";
process.env.WOO_SOLUTION_PEPTIDES_BASE_URL = "https://solutionpeptides.net";
process.env.WOO_ATOMIK_LABZ_BASE_URL = "https://atomiklabz.com";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: {
        configPath: "./test/wrangler.test.jsonc",
        environment: "test",
      },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            path.join(import.meta.dirname, "migrations"),
          ),
          BACKEND_AUTH_TOKEN: "test-backend-token",
          TENANT_KEY: "test-tenant",
          WOO_SOLUTION_PEPTIDES_BASE_URL: "https://solutionpeptides.net",
          WOO_ATOMIK_LABZ_BASE_URL: "https://atomiklabz.com",
          CF_ACCESS_TEAM_DOMAIN: "resolve.cloudflareaccess.com",
          CF_ACCESS_AUD: "test-access-audience",
          PHONE_CACHE_HMAC_KEY: "test-phone-cache-key",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
