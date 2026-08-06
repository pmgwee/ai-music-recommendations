import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // Mirror tsconfig's `paths` so route-handler tests can import the route
  // module (which uses `@/lib/...` aliases) without a runtime resolution
  // failure. `@music-ai/engine` resolves through pnpm's workspace link, so
  // it isn't re-aliased here.
  resolve: {
    alias: [
      {
        // `@/foo/bar` → `<root>/foo/bar`. Regex form (rather than a string
        // prefix) so `@music-ai/engine` is NOT matched — it has to keep
        // resolving through pnpm's workspace link.
        find: /^@\/(.+)$/,
        replacement: fileURLToPath(new URL("./$1", import.meta.url)),
      },
    ],
  },
  // .test.tsx defaults to jsdom via a per-file `// @vitest-environment jsdom`
  // first-line directive; the root default stays node so engine tests don't
  // pay the jsdom spin-up cost.
  test: { include: ["**/*.test.ts", "**/*.test.tsx"], environment: "node" },
});
