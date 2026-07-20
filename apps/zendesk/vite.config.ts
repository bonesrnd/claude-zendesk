import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: "src",
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: "../dist/assets",
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    include: ["**/*.test.{ts,tsx}"],
    setupFiles: ["../test/setup.ts"],
  },
});
