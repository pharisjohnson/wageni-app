import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "convex",
          // convex-test runs functions in an edge-like runtime.
          environment: "edge-runtime",
          include: ["tests/convex/**/*.test.ts"],
          // Staff PIN tests run PBKDF2 (100k iterations) many times; the default 5s
          // is too tight when files run in parallel on a busy machine or CI runner.
          testTimeout: 30_000,
          hookTimeout: 30_000,
          server: { deps: { inline: ["convex-test"] } },
        },
      },
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
    ],
  },
});
