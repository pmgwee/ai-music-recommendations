import { describe, it, expect } from "vitest";
import { ENGINE_VERSION } from "../src";

describe("engine package", () => {
  it("imports", () => expect(ENGINE_VERSION).toBe("0.0.0"));
});
