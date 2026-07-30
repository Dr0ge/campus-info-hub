import { describe, it, expect } from "bun:test";

// Dedup module is now async and calls DeepSeek — skip in unit tests.
// The title overlap pre-filter can still be tested via the exported functions
// once we expose them, but for now integration testing is sufficient.

describe("dedup", () => {
  it("module loads without error", async () => {
    const mod = await import("../src/dedup");
    expect(mod.checkDedup).toBeDefined();
    expect(mod.addToCache).toBeDefined();
  });
});
