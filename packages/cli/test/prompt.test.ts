import { describe, expect, it } from "vitest";
import { matchChoice, PromptAborted, promptLine } from "../src/prompt.js";

const ESC = String.fromCharCode(0x1b); // explicit code point, never a raw literal

// Prompt defaults carry env-detected and wire-fetched values — the one print path that used to
// skip the UNTRUSTED rule. Pin that the rendered line is stripped like every other surface.
describe("promptLine", () => {
  it("renders label + default", () => {
    expect(promptLine("Editor", "Neovim")).toBe("  Editor [Neovim]: ");
  });
  it("omits the bracket when there is no default", () => {
    expect(promptLine("Font")).toBe("  Font: ");
    expect(promptLine("Font", "")).toBe("  Font: ");
  });
  it("strips ANSI/control sequences from the default before display", () => {
    const line = promptLine("Editor", `Neo${ESC}[31mvim`);
    expect(line).toBe("  Editor [Neovim]: ");
    expect(line).not.toContain(ESC);
  });
  it("a default that is ONLY control characters renders as no default", () => {
    expect(promptLine("Editor", `${ESC}[2J`)).toBe("  Editor: ");
  });
  it("a hint follows the default in parentheses, before the colon", () => {
    expect(promptLine("Editor", "Zed", false, "detected: Neovim")).toBe(
      "  Editor [Zed] (detected: Neovim): ",
    );
    expect(promptLine("Editor", undefined, false, "detected: Neovim")).toBe(
      "  Editor (detected: Neovim): ",
    );
  });
  it("the hint is env-derived: sanitized, and one with nothing left prints no parentheses", () => {
    expect(promptLine("Editor", "Zed", false, `detected: Neo${ESC}[2Jvim`)).toBe(
      "  Editor [Zed] (detected: Neovim): ",
    );
    expect(promptLine("Editor", "Zed", false, `${ESC}[2J`)).toBe("  Editor [Zed]: ");
    expect(promptLine("Editor", "Zed", false, "")).toBe("  Editor [Zed]: ");
  });
  it("color mode dims the hint like the card's note, never amber", () => {
    expect(promptLine("Editor", "Zed", true, "detected: Neovim")).toBe(
      `  ${ESC}[90mEditor${ESC}[0m [Zed] ${ESC}[90m(detected: Neovim)${ESC}[0m: `,
    );
  });
  it("color mode dims the label only — default and punctuation stay plain ink", () => {
    expect(promptLine("Editor", "Neovim", true)).toBe(`  ${ESC}[90mEditor${ESC}[0m [Neovim]: `);
  });
});

describe("matchChoice", () => {
  const KEYS = ["y", "n", "e"] as const;
  it("empty input returns the default", () => {
    expect(matchChoice("", KEYS, "y")).toBe("y");
    expect(matchChoice("   ", KEYS, "y")).toBe("y");
  });
  it("matches on the first letter, case-insensitively, full words included", () => {
    expect(matchChoice("y", KEYS, "y")).toBe("y");
    expect(matchChoice("YES", KEYS, "y")).toBe("y");
    expect(matchChoice("no", KEYS, "y")).toBe("n");
    expect(matchChoice("EDIT", KEYS, "y")).toBe("e");
  });
  it("unmatched input returns null (the prompter re-asks)", () => {
    expect(matchChoice("q", KEYS, "y")).toBeNull();
    expect(matchChoice("-", KEYS, "y")).toBeNull();
    expect(matchChoice("publish", KEYS, "y")).toBeNull();
  });
  it("d matches only while it is offered; unoffered it re-asks like any other letter", () => {
    expect(matchChoice("d", ["y", "n", "e", "d"], "y")).toBe("d");
    expect(matchChoice("Detected", ["y", "n", "e", "d"], "y")).toBe("d");
    expect(matchChoice("", ["y", "n", "e", "d"], "y")).toBe("y");
    expect(matchChoice("d", KEYS, "y")).toBeNull();
  });
  it("exact: only the letter or yes/no match, so a tool name typed back at a take question re-asks", () => {
    const YN = ["y", "n"];
    expect(matchChoice("n", YN, "y", true)).toBe("n");
    expect(matchChoice(" NO ", YN, "y", true)).toBe("n");
    expect(matchChoice("Yes", YN, "y", true)).toBe("y");
    expect(matchChoice("", YN, "y", true)).toBe("y");
    expect(matchChoice("neovim", YN, "y", true)).toBeNull(); // not "n"
    expect(matchChoice("nvim", YN, "y", true)).toBeNull();
    expect(matchChoice("yazi", YN, "y", true)).toBeNull(); // not "y"
    expect(matchChoice("neovim", YN, "y")).toBe("n"); // the loose default, unchanged
  });

  it("throws loudly on colliding or multi-letter keys (programming error)", () => {
    expect(() => matchChoice("y", ["y", "y"], "y")).toThrow(/unique single letters/);
    expect(() => matchChoice("y", ["yes", "no"], "yes")).toThrow(/unique single letters/);
  });
});

describe("PromptAborted", () => {
  it("is an Error with a stable name for instanceof checks across the command layer", () => {
    const e = new PromptAborted();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("PromptAborted");
  });
});
