import { describe, expect, it } from "vitest";
import { sanitizeText } from "../src/lib/sanitize.ts";

// Built from code points so no control character appears in source.
const cp = (n: number) => String.fromCodePoint(n);
const RLO = cp(0x202e);
const MARK = cp(0xfffd);

describe("sanitizeText", () => {
  it("strips every Bidi_Control code point (pins the property's current membership)", () => {
    const controls = [
      0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f,
      0x061c,
    ];
    for (const n of controls) {
      expect(sanitizeText(`a${cp(n)}b`), `U+${n.toString(16)}`).toBe("ab");
    }
  });

  it("strips several controls at once, mid-word (Trojan-Source display spoofing)", () => {
    expect(sanitizeText(`zsh${RLO}evil${cp(0x2066)}${cp(0x200e)}`)).toBe("zshevil");
  });

  it("mark: replaces each control with U+FFFD instead of deleting it", () => {
    expect(sanitizeText(`zsh${RLO}`, { mark: true })).toBe(`zsh${MARK}`);
    expect(sanitizeText(`a${RLO}${cp(0x061c)}b`, { mark: true })).toBe(`a${MARK}${MARK}b`);
  });

  it("leaves RTL letters, zero-width space, plain text and URLs untouched", () => {
    const arabic = "\u0645\u0631\u062d\u0628\u0627";
    const hebrew = "\u05e9\u05dc\u05d5\u05dd";
    expect(sanitizeText(arabic)).toBe(arabic);
    expect(sanitizeText(hebrew)).toBe(hebrew);
    expect(sanitizeText(`a${cp(0x200b)}b`)).toBe(`a${cp(0x200b)}b`);
    expect(sanitizeText("Neovim 0.10")).toBe("Neovim 0.10");
    expect(sanitizeText("https://github.com/a/b")).toBe("https://github.com/a/b");
  });

  it("empty string stays empty", () => {
    expect(sanitizeText("")).toBe("");
    expect(sanitizeText("", { mark: true })).toBe("");
  });
});
