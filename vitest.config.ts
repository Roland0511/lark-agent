import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "admin/src/**/*.test.tsx"],
    coverage: { reporter: ["text", "json-summary"] }
  }
});
