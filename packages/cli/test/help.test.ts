import { readFileSync } from "node:fs";
import { CURATED_KEYS } from "@ymmv/shared";
import { describe, expect, it } from "vitest";

// The help text hand-maintains the curated-key list as prose. Grepping the SOURCE (rather than
// rendering help()) pins the key names as literals in index.ts — an interpolation that "helpfully"
// generates the list from CURATED_KEYS would pass a rendered-output check while breaking this
// tripwire's purpose: add a key without touching the help prose and this fails.
describe("HELP text stays in sync with CURATED_KEYS", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

  it.each([...CURATED_KEYS])("lists %s", (key) => {
    expect(source).toContain(key);
  });
});
