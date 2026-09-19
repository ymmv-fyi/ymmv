import { describe, expect, it } from "vitest";
import { hasVisibleContent } from "./visible.js";

// Code points spelled out so nothing invisible hides in the test source.
const ZWSP = String.fromCodePoint(0x200b); // zero-width space
const WJ = String.fromCodePoint(0x2060); // word joiner
const ALM = String.fromCodePoint(0x061c); // Arabic letter mark (outside the classic zero-width set)
const VS16 = String.fromCodePoint(0xfe0f); // variation selector-16
const RLO = String.fromCodePoint(0x202e); // right-to-left override

describe("hasVisibleContent", () => {
  it("is false for nothing, whitespace, and anything made only of invisible code points", () => {
    expect(hasVisibleContent("")).toBe(false);
    expect(hasVisibleContent("   ")).toBe(false);
    expect(hasVisibleContent("\t\n")).toBe(false);
    expect(hasVisibleContent(ZWSP)).toBe(false);
    expect(hasVisibleContent(`${ZWSP}${WJ}`)).toBe(false);
    expect(hasVisibleContent(ALM)).toBe(false);
    expect(hasVisibleContent(VS16)).toBe(false);
    expect(hasVisibleContent(RLO)).toBe(false);
    expect(hasVisibleContent(` ${ZWSP} `)).toBe(false);
  });

  it("sees past the BMP: astral tag characters are invisible too (the /u flag, not surrogates)", () => {
    // U+E0001..U+E007F are surrogate pairs in UTF-16. A regex without /u would match half a pair
    // and leave the other half behind, so the string would read as "visible". They are also the
    // classic hidden-text carrier, so a field made only of them must never store.
    const tag = String.fromCodePoint(0xe0001); // language tag
    const tagA = String.fromCodePoint(0xe0061); // tag small letter a
    expect(hasVisibleContent(tag)).toBe(false);
    expect(hasVisibleContent(`${tag}${tagA}`)).toBe(false);
    expect(hasVisibleContent(String.fromCodePoint(0x00ad))).toBe(false); // soft hyphen
    expect(hasVisibleContent(`vim${tagA}`)).toBe(true); // decorating real text is still data
  });

  it("is true once any visible character survives — invisibles decorating real text are data", () => {
    expect(hasVisibleContent("a")).toBe(true);
    expect(hasVisibleContent(" x ")).toBe(true);
    expect(hasVisibleContent(`${ZWSP}vim`)).toBe(true);
    expect(hasVisibleContent(`zsh${RLO}`)).toBe(true);
  });

  it("counts C0/C1 controls as invisible (they render as nothing, and trim() keeps them)", () => {
    const soh = String.fromCodePoint(0x01);
    const del = String.fromCodePoint(0x7f);
    const c1 = String.fromCodePoint(0x85);
    const esc = String.fromCodePoint(0x1b);
    expect(hasVisibleContent(soh)).toBe(false);
    expect(hasVisibleContent(`${del}${c1}`)).toBe(false);
    expect(hasVisibleContent(`${esc}[2J`)).toBe(true); // the bracket and letters are visible
    expect(hasVisibleContent(`a${soh}`)).toBe(true);
  });

  it("answers the same on repeated calls (a /g regex would carry lastIndex across tests)", () => {
    const v = `${ZWSP}vim`;
    expect([hasVisibleContent(v), hasVisibleContent(v), hasVisibleContent(v)]).toEqual([
      true,
      true,
      true,
    ]);
    expect([hasVisibleContent(ZWSP), hasVisibleContent(ZWSP)]).toEqual([false, false]);
  });
});
