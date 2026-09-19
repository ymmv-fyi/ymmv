import { displayUrl } from "@ymmv/shared";
import { describe, expect, it } from "vitest";
import { urlTitle } from "../src/lib/display-value.ts";

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
