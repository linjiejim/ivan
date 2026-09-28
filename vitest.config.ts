import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/server/src/**/*.test.ts",
      "apps/worker/src/**/*.test.ts",
      "apps/web/src/**/*.test.ts",
    ],
    environment: "node",
    testTimeout: 20_000,
  },
});
