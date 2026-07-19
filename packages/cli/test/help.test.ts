import { spawnSync } from "node:child_process";
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

// infra/waf-ratelimit.sh is the committed source of the zone-side WAF rate-limit rule, and two
// web sources point readers at it. Same repo-honesty class as the doc tripwires above (the
// original defect was exactly this pointer dangling), and it lives here because web tests run in
// workerd with no filesystem — this suite already reads repo-root files.
describe("infra/waf-ratelimit.sh stays present, honest, and secret-free", () => {
  const scriptUrl = new URL("../../../infra/waf-ratelimit.sh", import.meta.url);
  const script = readFileSync(scriptUrl, "utf8"); // a missing/renamed file throws right here

  it("carries the load-bearing atoms of the deployed rule", () => {
    for (const atom of [
      "http_ratelimit",
      "/api/v1/profile",
      "/api/v1/auth",
      '"POST"',
      '"DELETE"',
    ]) {
      expect(script).toContain(atom);
    }
  });

  it("takes credentials from env only and commits no secret-shaped literals", () => {
    expect(script).toContain("CLOUDFLARE_API_TOKEN");
    expect(script).toContain("CLOUDFLARE_ZONE_ID");
    expect(script).not.toMatch(/Bearer [A-Za-z0-9_-]{20,}/);
    // A 32-hex literal would be a pasted zone/ruleset/rule id — matching is by description and
    // expression precisely so no account-specific id needs committing.
    expect(script).not.toMatch(/\b[0-9a-f]{32}\b/);
  });

  it("both referencing web sources still point at this path (a rename trips here)", () => {
    for (const ref of [
      "../../../packages/web/wrangler.jsonc",
      "../../../packages/web/src/lib/rate-limit.ts",
    ]) {
      expect(readFileSync(new URL(ref, import.meta.url), "utf8")).toContain(
        "infra/waf-ratelimit.sh",
      );
    }
  });

  it("parses as bash (syntax tripwire; skips only where bash is unavailable)", () => {
    // The script is piped on stdin so this works under ANY bash (Git Bash, WSL, Linux CI) —
    // a Windows file path would be mangled by WSL's path rules. A launch failure OR a nonzero
    // exit WITHOUT a syntax diagnosis is an environment problem (WSL under parallel-suite load
    // flakes this way), not a script problem — skip loudly; `bash -n` always says "syntax error"
    // when the script is actually broken, and Linux CI runs the strict path.
    const res = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    if (res.error || (res.status !== 0 && !/syntax error/i.test(res.stderr ?? ""))) {
      console.warn("bash unavailable or failed to launch; skipping the syntax check");
      return;
    }
    expect(res.status, res.stderr).toBe(0);
  });
});
