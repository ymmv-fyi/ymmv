import { readFileSync } from "node:fs";
import { type CuratedKey, canonical, TOOLS } from "@ymmv/shared";
import { describe, expect, it } from "vitest";
import { KEY_EXAMPLES } from "../src/commands.js";
import { DETECTED_KEYS } from "../src/detect.js";

// The walk's examples are hand-written (the catalog lists only tools that need a diff alias), so
// this is what keeps them from drifting: a name the catalog or the detector knows must be spelled
// the way that source spells it. Its own file because commands.test.ts mocks detect.js.
const detectSource = readFileSync(new URL("../src/detect.ts", import.meta.url), "utf8");
const exampleKeys = Object.keys(KEY_EXAMPLES) as (keyof typeof KEY_EXAMPLES)[];

describe("walk hints", () => {
  it("a name the catalog knows is spelled as its canonical", () => {
    for (const key of exampleKeys) {
      for (const name of KEY_EXAMPLES[key]) {
        const known = TOOLS.filter(
          (t) => t.key === key && canonical(key, t.canonical) === canonical(key, name),
        );
        for (const tool of known) expect(name, `${key}: ${name}`).toBe(tool.canonical);
      }
    }
  });

  it("a name for a detected key is one the catalog or the detector can produce", () => {
    const detected: readonly CuratedKey[] = DETECTED_KEYS;
    for (const key of exampleKeys.filter((k) => detected.includes(k))) {
      for (const name of KEY_EXAMPLES[key]) {
        const inCatalog = TOOLS.some((t) => t.key === key && t.canonical === name);
        expect(inCatalog || detectSource.includes(`"${name}"`), `${key}: ${name}`).toBe(true);
      }
    }
  });
});
