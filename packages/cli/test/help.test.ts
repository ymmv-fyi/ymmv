import { readFileSync } from "node:fs";
import { CURATED_KEYS } from "@ymmv/shared";
import { describe, expect, it } from "vitest";

// The HELP text hand-maintains the curated-key list as prose (index.ts is the bin entry, so
// importing it would execute the CLI — pin the source text instead). This tripwire is what makes
// the hand-sync safe: add a key without touching HELP and this fails.
describe("HELP text stays in sync with CURATED_KEYS", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

  it.each([...CURATED_KEYS])("lists %s", (key) => {
    expect(source).toContain(key);
  });
});
