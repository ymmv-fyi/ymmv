import { describe, expect, it } from "vitest";
import { displayUrl, urlTitle } from "../src/lib/display-value.ts";

describe("displayUrl", () => {
  it("drops the https scheme (case-insensitive) for display", () => {
    expect(displayUrl("https://github.com/a/b")).toBe("github.com/a/b");
    expect(displayUrl("HTTPS://GitHub.com")).toBe("GitHub.com");
  });

  it("keeps http:// visible — a cleartext link target is noteworthy", () => {
    expect(displayUrl("http://github.com/a/b")).toBe("http://github.com/a/b");
  });

  it("never strips to an empty string (bare scheme stays intact)", () => {
    expect(displayUrl("https://")).toBe("https://");
  });

  it("trims before matching — stored values are untrimmed but compared trimmed", () => {
    expect(displayUrl("  https://a.b")).toBe("a.b");
  });

  it("leaves non-URL values untouched", () => {
    expect(displayUrl("Claude Code")).toBe("Claude Code");
    expect(displayUrl("javascript:alert(1)")).toBe("javascript:alert(1)");
    expect(displayUrl("say https:// in the middle")).toBe("say https:// in the middle");
  });
});

describe("urlTitle", () => {
  it("returns the full value only when the display was shortened", () => {
    expect(urlTitle("https://github.com/a")).toBe("https://github.com/a");
    expect(urlTitle("github.com/a")).toBeUndefined();
    expect(urlTitle("http://x")).toBeUndefined();
  });
});
