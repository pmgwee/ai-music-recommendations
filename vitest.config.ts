import { defineConfig } from "vitest/config";
export default defineConfig({
  // .test.tsx defaults to jsdom via a per-file `// @vitest-environment jsdom`
  // first-line directive; the root default stays node so engine tests don't
  // pay the jsdom spin-up cost.
  test: { include: ["**/*.test.ts", "**/*.test.tsx"], environment: "node" },
});
