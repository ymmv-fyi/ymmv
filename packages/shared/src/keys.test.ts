import { describe, expect, it } from "vitest";
import { CURATED_KEYS, isCuratedKey, KEY_LABELS } from "./keys.js";

describe("curated keys", () => {
  it("has 10 keys, all unique", () => {
    expect(CURATED_KEYS).toHaveLength(10);
    expect(new Set(CURATED_KEYS).size).toBe(10);
  });

  it("KEY_LABELS covers every curated key (and nothing else)", () => {
    expect(Object.keys(KEY_LABELS).sort()).toEqual([...CURATED_KEYS].sort());
    for (const key of CURATED_KEYS) {
      expect(KEY_LABELS[key]).toBeTruthy();
    }
  });

  it("isCuratedKey() guards membership", () => {
    expect(isCuratedKey("editor")).toBe(true);
    expect(isCuratedKey("ai-tool")).toBe(true);
    expect(isCuratedKey("launcher")).toBe(false);
    expect(isCuratedKey("")).toBe(false);
  });
});
