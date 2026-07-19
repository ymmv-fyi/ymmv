import { readFileSync } from "node:fs";
import { CURATED_KEYS } from "@ymmv/shared";
import { describe, expect, it } from "vitest";
import { DETECTED_KEYS } from "../src/detect.js";

// The help text hand-maintains the curated-key list as prose. Grepping the SOURCE (rather than
// rendering help()) pins the key names as literals in index.ts — an interpolation that "helpfully"
// generates the list from CURATED_KEYS would pass a rendered-output check while breaking this
// tripwire's purpose. The prose block is PARSED and compared as an exact set (not per-key
// substring matched: `os` also appears in `close()`, `prompt` in `makePrompter`, `terminal` in
// the tagline — whole-source matching silently never trips), so the tripwire fires in every
// direction: a dropped key, an unlisted new key, a stale key lingering after removal, a duplicate.
describe("HELP text stays in sync with CURATED_KEYS", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

  it("lists exactly the curated keys in the Curated keys: block", () => {
    const block = source.match(/Curated keys:\$\{c\.reset\}([^`]*)`/)?.[1];
    expect(block, "the Curated keys: block must exist in the help template").toBeTruthy();
    const listed = (block as string).split(/[,\s]+/).filter(Boolean);
    expect([...listed].sort()).toEqual([...CURATED_KEYS].sort());
    expect(listed).toHaveLength(new Set(listed).size); // no duplicates in the prose either
  });
});

// docs/api.md hand-maintains the same list for API consumers (the published contract doc).
// Same tripwire, same rationale: add a curated key without touching the doc and this fails.
// Keys appear backtick-wrapped in the doc, so the match is word-bounded.
describe("docs/api.md stays in sync with CURATED_KEYS", () => {
  const doc = readFileSync(new URL("../../../docs/api.md", import.meta.url), "utf8");

  it.each([...CURATED_KEYS])("lists %s", (key) => {
    expect(doc).toContain(`\`${key}\``);
  });
});

// The root README's "Auto-detected" bullet is the privacy disclosure of what the CLI reads from
// the environment — it drifted from detectStack once (under-reporting two probed fields), so it
// gets the same treatment: chained to DETECTED_KEYS (whose own completeness is pinned against
// detectStack in detect.test.ts). Prose uses display labels, so the map below translates; a
// detected key with no map entry fails loudly instead of skipping.
describe("README Auto-detected list stays in sync with DETECTED_KEYS", () => {
  const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  const bullet = readme.match(/\*\*Auto-detected\.\*\*([\s\S]*?)(?:\n- |\n\n)/)?.[1];

  const README_LABELS: Record<(typeof DETECTED_KEYS)[number], string> = {
    os: "OS",
    shell: "shell",
    prompt: "prompt",
    terminal: "terminal",
    editor: "editor",
    multiplexer: "multiplexer",
    "version-manager": "version manager",
    "window-manager": "window manager",
    browser: "browser",
    "ai-tool": "AI tool",
  };

  it("has the Auto-detected bullet", () => {
    expect(bullet, "the **Auto-detected.** bullet must exist in README.md").toBeTruthy();
  });

  it.each([...DETECTED_KEYS])("names %s", (key) => {
    const label = README_LABELS[key];
    expect(label, `add a README label mapping for new detected key "${key}"`).toBeTruthy();
    expect(bullet).toContain(label);
  });
});
