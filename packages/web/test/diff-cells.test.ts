import { describe, expect, it } from "vitest";
import { pairCells } from "../src/lib/diff-cells.ts";

const RLO = String.fromCodePoint(0x202e);
const LRO = String.fromCodePoint(0x202d);
const ZWSP = String.fromCodePoint(0x200b);
const NBSP = String.fromCodePoint(0xa0);
const FFFD = String.fromCodePoint(0xfffd);
const texts = (a: string, b: string) => pairCells(a, b, true).map((c) => c?.text);

describe("pairCells", () => {
  it("a one-sided row shortens the present side and carries the full URL as its title", () => {
    expect(pairCells("https://github.com/a", null, true)).toEqual([
      { text: "github.com/a", title: "https://github.com/a" },
      null,
    ]);
    expect(pairCells(null, "Neovim", true)).toEqual([null, { text: "Neovim", title: undefined }]);
  });

  it("strips bidi controls from text and title", () => {
    expect(pairCells(`https://github.com/${RLO}bidi`, null, true)).toEqual([
      { text: "github.com/bidi", title: "https://github.com/bidi" },
      null,
    ]);
  });

  it("shortens both sides, with titles, when the shown texts stay distinct", () => {
    expect(pairCells(`https://github.com/${RLO}a`, "https://github.com/b", true)).toEqual([
      { text: "github.com/a", title: "https://github.com/a" },
      { text: "github.com/b", title: "https://github.com/b" },
    ]);
    expect(pairCells("https://github.com/a", "Neovim", true)).toEqual([
      { text: "github.com/a", title: "https://github.com/a" },
      { text: "Neovim", title: undefined },
    ]);
  });

  it("a row the diff calls same never collides, even when the raw sides differ by a trim", () => {
    expect(pairCells("https://github.com/a/dots", "https://github.com/a/dots ", false)).toEqual([
      { text: "github.com/a/dots", title: "https://github.com/a/dots" },
      { text: "github.com/a/dots", title: "https://github.com/a/dots" },
    ]);
  });

  it("renders raw, without titles, when shortening would collide the sides", () => {
    for (const [a, b] of [
      ["https://github.com/plain/dots", "github.com/plain/dots"],
      ["https://GitHub.com/x", "https://github.com/x"],
      ["https://good.com@evil.com", "https://evil.com"],
      ["https://a.com:443/x", "https://a.com/x"],
    ]) {
      expect(pairCells(a, b, true)).toEqual([
        { text: a, title: undefined },
        { text: b, title: undefined },
      ]);
    }
  });

  it("marks a bidi-only difference instead of stripping it into two equal strings", () => {
    expect(texts("zsh", `zsh${RLO}`)).toEqual(["zsh", `zsh${FFFD}`]);
  });

  it("falls back to raw when the userinfo drop plus marking would still coincide", () => {
    // shortened and marked, both sides read "a.com/<FFFD>X"; the raw values differ by userinfo
    expect(texts(`https://alice@a.com/${RLO}X`, `https://bob@a.com/${LRO}X`)).toEqual([
      "https://alice@a.com/X",
      "https://bob@a.com/X",
    ]);
  });

  it("treats whitespace the browser collapses, and NBSP, as a collision", () => {
    expect(texts("https://alice@a.com/a b", "https://bob@a.com/a  b")).toEqual([
      "https://alice@a.com/a b",
      "https://bob@a.com/a  b",
    ]);
    expect(texts(`https://alice@a.com/a${NBSP}b`, "https://bob@a.com/a b")).toEqual([
      `https://alice@a.com/a${NBSP}b`,
      "https://bob@a.com/a b",
    ]);
    // a stripped control next to a collapsed run: the marker alone keeps the cells apart
    expect(texts(`https://a.com/a b${RLO}`, "https://a.com/a  b")).toEqual([
      `a.com/a b${FFFD}`,
      "a.com/a  b",
    ]);
  });

  it("a joiner or variation selector shapes a glyph, so it is a visible difference, never marked", () => {
    const ZWJ = String.fromCodePoint(0x200d);
    const VS16 = String.fromCodePoint(0xfe0f);
    const man = String.fromCodePoint(0x1f468);
    const laptop = String.fromCodePoint(0x1f4bb);
    const heart = String.fromCodePoint(0x2764);
    expect(texts(`${man}${ZWJ}${laptop}`, `${man}${laptop}`)).toEqual([
      `${man}${ZWJ}${laptop}`,
      `${man}${laptop}`,
    ]);
    expect(texts(`Fira Code ${heart}${VS16}`, `Fira Code ${heart}`)).toEqual([
      `Fira Code ${heart}${VS16}`,
      `Fira Code ${heart}`,
    ]);
  });

  it("marks an invisible-only difference the host rewrite would otherwise hide", () => {
    // IDNA maps the zero-width space away, so both shorten to google.com; the raw sides differ
    // only by a code point that takes no space, so it is marked rather than left invisible
    expect(texts(`https://goo${ZWSP}gle.com`, "https://google.com")).toEqual([
      `https://goo${FFFD}gle.com`,
      "https://google.com",
    ]);
  });
});
