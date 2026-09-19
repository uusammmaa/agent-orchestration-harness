import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts"],
    // Postgres contract tests run serially against one database.
    fileParallelism: false,
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      "@harness/core/postgres": path.resolve(__dirname, "packages/core/src/postgres-entry.ts"),
      "@harness/core": path.resolve(__dirname, "packages/core/src/index.ts"),
      "@harness/odoo": path.resolve(__dirname, "packages/odoo/src/index.ts"),
      "@harness/agents": path.resolve(__dirname, "packages/agents/src/index.ts"),
    },
  },
});
