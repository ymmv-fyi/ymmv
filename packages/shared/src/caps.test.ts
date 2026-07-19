import { describe, expect, it } from "vitest";
import { MAX_ENTRIES, MAX_EXTRAS, MAX_LABEL, MAX_VALUE } from "./caps.js";

describe("write caps", () => {
  it("pins the product write caps both surfaces enforce", () => {
    // Load-bearing: the web boundary tests (257 rejects / 256 accepts, 33 extras, 65 label) and the
    // CLI pre-flight both assume exactly these values. A change here is a product decision — and a
    // RAISE is soft-breaking for shipped CLIs (see the caps.ts comment) — not a refactor.
    expect(MAX_ENTRIES).toBe(50);
    expect(MAX_EXTRAS).toBe(32);
    expect(MAX_LABEL).toBe(64);
    expect(MAX_VALUE).toBe(256);
  });
});
