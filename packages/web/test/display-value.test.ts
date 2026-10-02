import { displayUrl } from "@ymmv/shared";
import { describe, expect, it } from "vitest";
import { slashSegments, urlTitle } from "../src/lib/display-value.ts";

const RLO = String.fromCodePoint(0x202e);

describe("urlTitle", () => {
  it("returns the full value only when the display was shortened", () => {
    expect(urlTitle("https://github.com/a")).toBe("https://github.com/a");
    expect(urlTitle("github.com/a")).toBeUndefined();
    expect(urlTitle("http://x")).toBeUndefined();
  });

  it("carries the full URL when the display dropped userinfo or normalized the host", () => {
    expect(urlTitle("https://good.com@evil.com")).toBe("https://good.com@evil.com");
    expect(urlTitle("http://GitHub.com/x")).toBe("http://GitHub.com/x");
  });

  it("a trim alone earns no tooltip, and the title is sanitized like the text", () => {
    expect(urlTitle("  github.com/a  ")).toBeUndefined();
    expect(urlTitle(`https://github.com/${RLO}bidi`)).toBe("https://github.com/bidi");
  });
});

describe("slashSegments", () => {
  it("cuts a URL's display text after each slash", () => {
    expect(slashSegments("github.com/antfu/dotfiles")).toEqual([
      "github.com/",
      "antfu/",
      "dotfiles",
    ]);
  });

  it("cuts after a run of slashes, never inside one: a kept scheme's // stays together", () => {
    expect(slashSegments("http://x.dev/a")).toEqual(["http://", "x.dev/", "a"]);
    expect(slashSegments("a.com/x//y///z")).toEqual(["a.com/", "x//", "y///", "z"]);
  });

  it("a trailing slash ends the last piece and adds no empty one", () => {
    expect(slashSegments("github.com/antfu/")).toEqual(["github.com/", "antfu/"]);
    expect(slashSegments("a.com//")).toEqual(["a.com//"]);
  });

  it("a string with no slash is one piece", () => {
    expect(slashSegments("github.com")).toEqual(["github.com"]);
    expect(slashSegments("")).toEqual([""]);
  });

  it("the pieces join back to the input", () => {
    for (const text of ["github.com/a/b", "http://x//y/", "/", "//a", "a/b?c=d/e#f/g"]) {
      expect(slashSegments(text).join("")).toBe(text);
    }
  });
});

describe("displayUrl under workerd", () => {
  // The shared unit tests run under Node; the page renders under workerd, whose URL parser is the
  // one that decides the shown host. Pin the two authority rewrites the profile page relies on.
  it("drops userinfo and shows an IDN host as punycode", () => {
    expect(displayUrl("https://good.com@evil.com/x")).toBe("evil.com/x");
    const lookalike = `https://${String.fromCodePoint(0x430, 0x440, 0x440, 0x4cf, 0x435)}.com`;
    expect(displayUrl(lookalike)).toBe("xn--80ak6aa92e.com");
  });

  it("leaves a parse failure as raw text, so it never borrows a link's look", () => {
    expect(displayUrl("https://evil com")).toBe("https://evil com");
  });
});
