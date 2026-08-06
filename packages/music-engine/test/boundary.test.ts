import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = readdirSync(root).filter((f) => f.endsWith(".ts"));

describe("engine purity (SC1)", () => {
  for (const f of files) {
    it(`${f} has no app-framework imports`, () => {
      const src = readFileSync(join(root, f), "utf8");
      expect(src).not.toMatch(/from\s+["']next["']/);
      expect(src).not.toMatch(/from\s+["']@supabase\//);
      expect(src).not.toMatch(/from\s+["']react["']/);
      expect(src).not.toMatch(/"use client"/);
      expect(src).not.toMatch(/"server-only"/);
    });
  }
});
