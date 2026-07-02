import { describe, expect, it } from "vitest";
import { CURATED_KEYS, type CuratedKey } from "./keys.js";
import { canonical, fold } from "./normalize.js";
import { TOOLS } from "./tools.js";

// Built from code points (ASCII source) so the two byte sequences are genuinely different:
// composed "é" (U+00E9) vs "e" + combining acute accent (U+0301).
const CAFE_COMPOSED = `caf${String.fromCharCode(0x00e9)}`;
const CAFE_DECOMPOSED = `cafe${String.fromCharCode(0x0301)}`;

describe("fold()", () => {
  it("lowercases", () => {
    expect(fold("Firefox")).toBe("firefox");
  });
  it("strips all whitespace", () => {
    expect(fold("VS  Code")).toBe("vscode");
    expect(fold(" zsh ")).toBe("zsh");
  });
  it("normalizes composed and decomposed Unicode to the same token", () => {
    expect(CAFE_COMPOSED).not.toBe(CAFE_DECOMPOSED); // sanity: genuinely different inputs
    expect(fold(CAFE_COMPOSED)).toBe(fold(CAFE_DECOMPOSED));
  });
  it("folds empty and whitespace-only input to an empty token", () => {
    expect(fold("")).toBe("");
    expect(fold("   ")).toBe("");
    expect(fold("\t\n ")).toBe("");
  });
  it("is idempotent", () => {
    for (const v of ["VS Code", "  Fira Code ", CAFE_DECOMPOSED]) {
      expect(fold(fold(v))).toBe(fold(v));
    }
  });
});

describe("canonical()", () => {
  it("resolves a curated alias to the tool's folded canonical", () => {
    expect(canonical("editor", "vsc")).toBe(fold("VS Code"));
    expect(canonical("editor", "nvim")).toBe(fold("Neovim"));
    expect(canonical("shell", "pwsh")).toBe(fold("PowerShell"));
  });
  it("falls through to the folded value on a miss", () => {
    expect(canonical("editor", "Zed")).toBe("zed");
    expect(canonical("font", "JetBrains Mono")).toBe("jetbrainsmono"); // font has no alias table
  });
  it("compares dotfiles verbatim (trim only, case-sensitive) — never folds a URL", () => {
    const url = "https://github.com/antfu/Dotfiles";
    expect(canonical("dotfiles", `  ${url}  `)).toBe(url); // trimmed, not folded
    expect(canonical("dotfiles", url)).not.toBe(canonical("dotfiles", url.toLowerCase())); // case kept
  });
  it("does NOT treat detector-only envTokens as diff aliases", () => {
    expect(canonical("editor", "vi")).toBe("vi"); // envToken of Vim, but not a diff alias
    expect(canonical("editor", "vi")).not.toBe(canonical("editor", "Vim"));
    expect(canonical("terminal", "apple_terminal")).toBe("apple_terminal"); // not "terminal"
  });
  it("theme aliases bridge what fold can't: hyphens and the é in Rosé Pine", () => {
    // Explicit code point (composed é, U+00E9) so the source can't be silently re-normalized,
    // and the premise is asserted, not assumed: fold alone does NOT equate é with e — the alias
    // is load-bearing.
    const ROSE = `Ros${String.fromCharCode(0x00e9)} Pine`;
    expect(fold("Rose Pine")).not.toBe(fold(ROSE));
    expect(canonical("theme", "rose-pine")).toBe(fold(ROSE));
    expect(canonical("theme", "Rose Pine")).toBe(fold(ROSE));
    expect(canonical("theme", "tokyo-night")).toBe(fold("Tokyo Night"));
    expect(canonical("theme", "tokyonight")).toBe(fold("Tokyo Night")); // fold alone equates this one
    expect(canonical("prompt", "p10k")).toBe(fold("Powerlevel10k"));
    expect(canonical("prompt", "oh-my-posh")).toBe(fold("Oh My Posh"));
  });
  it("hyphenated browser binary names are diff aliases (typed = detected)", () => {
    expect(canonical("browser", "google-chrome")).toBe(fold("Chrome"));
    expect(canonical("browser", "microsoft-edge")).toBe(fold("Edge"));
    expect(canonical("browser", "brave-browser")).toBe(fold("Brave"));
    expect(canonical("browser", "zen-browser")).toBe(fold("Zen"));
  });
  it("collapses empty/whitespace-only input per key kind", () => {
    expect(canonical("editor", "")).toBe("");
    expect(canonical("editor", "   ")).toBe("");
    expect(canonical("dotfiles", "   ")).toBe(""); // raw key: trim-only, still empty
  });
  it("is prototype-safe — inherited object keys never leak a non-string", () => {
    // A user-published value folding to "__proto__"/"constructor" must not read Object.prototype
    // off the alias bucket; it falls through to the folded string.
    for (const key of ["editor", "os", "terminal"] as const) {
      expect(canonical(key, "__proto__")).toBe("__proto__");
      expect(canonical(key, "constructor")).toBe("constructor");
    }
  });
});

describe("TOOLS catalog invariants (guard the derived alias map)", () => {
  it("every listed variant resolves to its tool, and lookup is single-hop (idempotent)", () => {
    for (const tool of TOOLS) {
      const target = fold(tool.canonical);
      for (const v of [tool.canonical, ...(tool.aliases ?? [])]) {
        expect(canonical(tool.key, v)).toBe(target);
        expect(canonical(tool.key, canonical(tool.key, v))).toBe(canonical(tool.key, v));
      }
    }
  });

  it("no folded variant maps to two different tools within a field (no ambiguous alias)", () => {
    for (const key of CURATED_KEYS) {
      const seen = new Map<string, string>();
      for (const tool of TOOLS.filter((t) => t.key === key)) {
        const target = fold(tool.canonical);
        for (const v of [tool.canonical, ...(tool.aliases ?? [])]) {
          const f = fold(v);
          const prior = seen.get(f);
          expect(prior === undefined || prior === target).toBe(true);
          seen.set(f, target);
        }
      }
    }
  });

  it("distinct tools never share a canonical identity within a field", () => {
    for (const key of CURATED_KEYS as readonly CuratedKey[]) {
      const canons = TOOLS.filter((t) => t.key === key).map((t) => fold(t.canonical));
      expect(new Set(canons).size).toBe(canons.length);
    }
  });
});
