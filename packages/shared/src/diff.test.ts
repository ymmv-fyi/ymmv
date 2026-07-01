import { describe, expect, it } from "vitest";
import { diff } from "./diff.js";
import type { CuratedKey } from "./keys.js";
import type { Entry, Extra, Profile } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

function profile(entries: Entry[], extras: Extra[] = []): Profile {
  return {
    schema_version: SCHEMA_VERSION,
    handle: "test",
    entries,
    extras,
    updated_at: "2026-06-28T00:00:00Z",
  };
}

// Composed vs decomposed accent built from code points (ASCII source) — genuinely different bytes.
const CAFE_COMPOSED = `caf${String.fromCharCode(0x00e9)}`; // U+00E9
const CAFE_DECOMPOSED = `cafe${String.fromCharCode(0x0301)}`; // e + combining acute

describe("diff()", () => {
  it("1. identical — every row `same`, differ 0", () => {
    const both = profile([
      { key: "editor", value: "vim" },
      { key: "shell", value: "zsh" },
    ]);
    const result = diff(both, profile([...both.entries]));
    expect(result.rows.every((r) => r.status === "same")).toBe(true);
    expect(result.differ).toBe(0);
    expect(result.shared).toBe(2);
  });

  it("2. key equal — that row is `same`", () => {
    const result = diff(
      profile([{ key: "editor", value: "vim" }]),
      profile([{ key: "editor", value: "vim" }]),
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.status).toBe("same");
  });

  it("3. key differ — `changed`, counted in differ", () => {
    const result = diff(
      profile([{ key: "shell", value: "zsh" }]),
      profile([{ key: "shell", value: "fish" }]),
    );
    expect(result.rows[0]).toMatchObject({ status: "changed", mine: "zsh", theirs: "fish" });
    expect(result.differ).toBe(1);
    expect(result.shared).toBe(0);
  });

  it("4. only-mine — `only_mine`, theirs null", () => {
    const result = diff(profile([{ key: "os", value: "macos" }]), profile([]));
    expect(result.rows[0]).toMatchObject({ status: "only_mine", mine: "macos", theirs: null });
    expect(result.differ).toBe(1);
  });

  it("5. only-theirs — `only_theirs`, mine null", () => {
    const result = diff(profile([]), profile([{ key: "os", value: "linux" }]));
    expect(result.rows[0]).toMatchObject({ status: "only_theirs", mine: null, theirs: "linux" });
    expect(result.differ).toBe(1);
  });

  it("6. extras render as a separate block — never rows, never mismatches", () => {
    const result = diff(
      profile([{ key: "editor", value: "vim" }], [{ label: "Launcher", value: "Raycast" }]),
      profile([{ key: "editor", value: "vim" }], [{ label: "Keyboard", value: "HHKB" }]),
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.status).toBe("same");
    expect(result.extras.mine).toEqual([{ label: "Launcher", value: "Raycast" }]);
    expect(result.extras.theirs).toEqual([{ label: "Keyboard", value: "HHKB" }]);
  });

  it("7. empty mine — every theirs key is only_theirs, shared 0", () => {
    const result = diff(
      profile([]),
      profile([
        { key: "editor", value: "vim" },
        { key: "shell", value: "zsh" },
      ]),
    );
    expect(result.rows.every((r) => r.status === "only_theirs")).toBe(true);
    expect(result.shared).toBe(0);
    expect(result.differ).toBe(2);
  });

  it("8. empty theirs — every mine key is only_mine", () => {
    const result = diff(profile([{ key: "editor", value: "vim" }]), profile([]));
    expect(result.rows.every((r) => r.status === "only_mine")).toBe(true);
  });

  it("9. both empty — no rows, zero counts, empty extras", () => {
    const result = diff(profile([]), profile([]));
    expect(result.rows).toEqual([]);
    expect(result.differ).toBe(0);
    expect(result.shared).toBe(0);
    expect(result.extras).toEqual({ mine: [], theirs: [] });
  });

  it("10. ordering — rows follow CURATED_KEYS order regardless of input order", () => {
    const result = diff(
      profile([
        { key: "shell", value: "zsh" },
        { key: "editor", value: "vim" },
        { key: "browser", value: "firefox" },
      ]),
      profile([]),
    );
    expect(result.rows.map((r) => r.key)).toEqual(["editor", "shell", "browser"]);
  });

  it("11. counts invariant — differ + shared === rows.length", () => {
    const result = diff(
      profile([
        { key: "editor", value: "vim" }, // same
        { key: "shell", value: "zsh" }, // changed
        { key: "os", value: "macos" }, // only_mine
      ]),
      profile([
        { key: "editor", value: "vim" }, // same
        { key: "shell", value: "fish" }, // changed
        { key: "terminal", value: "ghostty" }, // only_theirs
      ]),
    );
    expect(result.differ + result.shared).toBe(result.rows.length);
    expect(result.shared).toBe(1);
    expect(result.differ).toBe(3);
  });

  it("12. purity — inputs unmutated, output stable", () => {
    const mine = profile([{ key: "editor", value: "vim" }], [{ label: "L", value: "V" }]);
    const theirs = profile([{ key: "editor", value: "nano" }]);
    const mineSnap = structuredClone(mine);
    const theirsSnap = structuredClone(theirs);
    const a = diff(mine, theirs);
    const b = diff(mine, theirs);
    expect(mine).toEqual(mineSnap);
    expect(theirs).toEqual(theirsSnap);
    expect(a).toEqual(b);
  });

  it("13. trim-equality — whitespace-only difference is `same` (eng-review)", () => {
    const result = diff(
      profile([{ key: "shell", value: "zsh" }]),
      profile([{ key: "shell", value: "zsh " }]),
    );
    expect(result.rows[0]?.status).toBe("same");
    // displayed verbatim — trimming is for comparison only
    expect(result.rows[0]?.theirs).toBe("zsh ");
  });

  it("14. duplicate-key last-wins (eng-review)", () => {
    const result = diff(
      profile([
        { key: "editor", value: "vim" },
        { key: "editor", value: "zed" },
      ]),
      profile([{ key: "editor", value: "zed" }]),
    );
    expect(result.rows[0]?.mine).toBe("zed");
    expect(result.rows[0]?.status).toBe("same");
  });

  it("15. non-curated key in entries is ignored (eng-review)", () => {
    const mine = profile([
      { key: "editor", value: "vim" },
      { key: "launcher", value: "raycast" } as unknown as Entry,
    ]);
    const result = diff(mine, profile([]));
    expect(result.rows.map((r) => r.key)).toEqual(["editor"]);
  });

  it("16. case-insensitive — Firefox === firefox, values still verbatim", () => {
    const result = diff(
      profile([{ key: "browser", value: "Firefox" }]),
      profile([{ key: "browser", value: "firefox" }]),
    );
    expect(result.rows[0]?.status).toBe("same");
    expect(result.rows[0]).toMatchObject({ mine: "Firefox", theirs: "firefox" });
  });

  it("17. Unicode NFC — composed and decomposed forms are `same`", () => {
    expect(CAFE_COMPOSED).not.toBe(CAFE_DECOMPOSED); // sanity: genuinely different inputs
    const result = diff(
      profile([{ key: "font", value: CAFE_COMPOSED }]),
      profile([{ key: "font", value: CAFE_DECOMPOSED }]),
    );
    expect(result.rows[0]?.status).toBe("same");
  });

  it("18. whitespace-insensitive — 'VS Code'='vscode', 'JetBrains Mono'='JetBrainsMono'", () => {
    const editor = diff(
      profile([{ key: "editor", value: "VS Code" }]),
      profile([{ key: "editor", value: "vscode" }]),
    );
    expect(editor.rows[0]?.status).toBe("same");
    const font = diff(
      profile([{ key: "font", value: "JetBrains Mono" }]),
      profile([{ key: "font", value: "JetBrainsMono" }]),
    );
    expect(font.rows[0]?.status).toBe("same");
  });

  it("19. curated aliases — Code=VS Code, nvim=Neovim, pwsh=PowerShell", () => {
    const pairs: [CuratedKey, string, string][] = [
      ["editor", "vsc", "VS Code"],
      ["editor", "nvim", "Neovim"],
      ["shell", "pwsh", "PowerShell"],
    ];
    for (const [key, a, b] of pairs) {
      const result = diff(profile([{ key, value: a }]), profile([{ key, value: b }]));
      expect(result.rows[0]?.status, `${a} vs ${b}`).toBe("same");
    }
  });

  it("20. no false positives — distinct tools stay `changed`", () => {
    const pairs: [CuratedKey, string, string][] = [
      ["editor", "Vim", "Neovim"],
      ["editor", "vi", "Vim"], // detector token, NOT a diff alias
      ["editor", "Code", "VS Code"], // "Code" (elementary's editor) is not aliased to VS Code
      ["browser", "Chrome", "Chromium"],
      ["os", "macOS 15.2", "macOS 15.4"], // versions are real differences
      ["ai-tool", "Claude", "Claude Code"],
    ];
    for (const [key, a, b] of pairs) {
      const result = diff(profile([{ key, value: a }]), profile([{ key, value: b }]));
      expect(result.rows[0]?.status, `${a} vs ${b}`).toBe("changed");
    }
  });

  it("21. dotfiles (URL) compares verbatim — trim-equal is `same`, case/path differ is `changed`", () => {
    const base = "https://github.com/antfu/dotfiles";
    const trimmed = diff(
      profile([{ key: "dotfiles", value: base }]),
      profile([{ key: "dotfiles", value: `${base} ` }]),
    );
    expect(trimmed.rows[0]?.status).toBe("same"); // trim only
    const cased = diff(
      profile([{ key: "dotfiles", value: base }]),
      profile([{ key: "dotfiles", value: "https://github.com/antfu/Dotfiles" }]),
    );
    expect(cased.rows[0]?.status).toBe("changed"); // case significant for URLs
  });
});
