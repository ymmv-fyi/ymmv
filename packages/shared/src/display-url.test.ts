import { describe, expect, it } from "vitest";
import { displayUrl } from "./display-url.js";

const RLO = String.fromCodePoint(0x202e);

describe("displayUrl", () => {
  it("drops the https scheme for display", () => {
    expect(displayUrl("https://github.com/a/b")).toBe("github.com/a/b");
    expect(displayUrl("https://a.com/?q#h")).toBe("a.com/?q#h");
  });

  it("shows the host the link actually hits: userinfo is dropped", () => {
    expect(displayUrl("https://good.com@evil.com/x")).toBe("evil.com/x");
    expect(displayUrl("https://user:pw@evil.com")).toBe("evil.com");
    expect(displayUrl("http://good.com@evil.com")).toBe("http://evil.com");
  });

  it("shows an IDN host as punycode, so a lookalike cannot pass for the real thing", () => {
    // Cyrillic а р р ӏ е
    const lookalike = `https://${String.fromCodePoint(0x430, 0x440, 0x440, 0x4cf, 0x435)}.com`;
    expect(displayUrl(lookalike)).toBe("xn--80ak6aa92e.com");
    expect(displayUrl("https://xn--80ak6aa92e.com")).toBe("xn--80ak6aa92e.com");
  });

  it("uses the parser's host: lowercased, default port dropped, other ports kept", () => {
    expect(displayUrl("HTTPS://GitHub.com")).toBe("github.com");
    expect(displayUrl("https://a.com:443/x")).toBe("a.com/x");
    expect(displayUrl("https://a.com:8080/x")).toBe("a.com:8080/x");
    expect(displayUrl("https://[::1]:8443/p")).toBe("[::1]:8443/p");
  });

  it("keeps a query or hash that follows the authority directly (no slash inserted)", () => {
    // url.pathname would say "/?q"; the rest is the raw text, so nothing is invented
    expect(displayUrl("https://a.com?q=1")).toBe("a.com?q=1");
    expect(displayUrl("https://a.com#h")).toBe("a.com#h");
    expect(displayUrl("https://a.com/")).toBe("a.com/");
  });

  it("normalizes the scheme case too: HTTP:// shows as http://", () => {
    expect(displayUrl("HTTP://Example.com/p")).toBe("http://example.com/p");
    expect(displayUrl("Http://a.com")).toBe("http://a.com");
  });

  it("drops only the scheme's own default port, not the other scheme's", () => {
    expect(displayUrl("https://a.com:80/x")).toBe("a.com:80/x");
    expect(displayUrl("http://a.com:80/x")).toBe("http://a.com/x");
    expect(displayUrl("http://a.com:443/x")).toBe("http://a.com:443/x");
  });

  it("keeps http:// visible (a cleartext link target is noteworthy) with the same host rule", () => {
    expect(displayUrl("http://github.com/a/b")).toBe("http://github.com/a/b");
    expect(displayUrl("http://Example.com/p")).toBe("http://example.com/p");
  });

  it("keeps the path verbatim (no percent-encoding), so the render-time bidi strip still applies", () => {
    expect(displayUrl(`https://github.com/${RLO}bidi`)).toBe(`github.com/${RLO}bidi`);
    expect(displayUrl("https://a.com/b c")).toBe("a.com/b c");
    expect(displayUrl("https://a.com/\u00fcber")).toBe("a.com/\u00fcber");
  });

  it("agrees with the parser on what is a link: any slash run after the scheme, or none", () => {
    // safeHref links all of these to evil.com, so the label must show that host
    for (const v of [
      "https:good.com@evil.com/x",
      "https:/good.com@evil.com/x",
      "https:\\\\good.com@evil.com/x",
      "https:///good.com@evil.com/x",
      "https://\\good.com@evil.com/x",
    ]) {
      expect(new URL(v).host).toBe("evil.com");
      expect(displayUrl(v)).toBe("evil.com/x");
    }
    expect(displayUrl("https:///x")).toBe("x");
    expect(displayUrl("HTTPS:/GitHub.com")).toBe("github.com");
  });

  it("agrees with the parser on tab/newline (stripped anywhere) and C0 at the edges", () => {
    const NL = String.fromCharCode(10);
    const TAB = String.fromCharCode(9);
    const SOH = String.fromCharCode(1);
    const LS = String.fromCodePoint(0x2028);
    const lookalike = String.fromCodePoint(0x430, 0x440, 0x440, 0x4cf, 0x435);
    // LF/CR go the way the parser sends them; other line terminators stay verbatim in the rest
    expect(displayUrl(`https://good.com@evil.com/${NL}foo`)).toBe("evil.com/foo");
    expect(displayUrl(`https://good.com@evil.com/${LS}foo`)).toBe(`evil.com/${LS}foo`);
    expect(displayUrl(`https://${lookalike}.com/${NL}x`)).toBe("xn--80ak6aa92e.com/x");
    // the parser ignores these before it looks at the scheme, so the gate must too
    expect(displayUrl(`ht${TAB}tps://good.com@evil.com/x`)).toBe("evil.com/x");
    expect(displayUrl(`${SOH}https://good.com@evil.com/x`)).toBe("evil.com/x");
    expect(displayUrl(`https://good.com@evil${NL}.com/x`)).toBe("evil.com/x");
  });

  it("a backslash, ? or # ends the authority like the parser does", () => {
    expect(displayUrl("https://good.com?@evil.com")).toBe("good.com?@evil.com");
    expect(displayUrl("https://good.com#@evil.com")).toBe("good.com#@evil.com");
    expect(displayUrl("https://good.com\\@evil.com")).toBe("good.com\\@evil.com");
  });

  it("never strips to an empty string (bare scheme stays intact)", () => {
    expect(displayUrl("https://")).toBe("https://");
    expect(displayUrl("https://?x")).toBe("https://?x");
  });

  it("trims before matching (stored values are untrimmed but compared trimmed)", () => {
    expect(displayUrl("  https://a.b")).toBe("a.b");
    expect(displayUrl("  plain  ")).toBe("plain");
  });

  it("leaves non-links untouched: parse failures and non-http schemes keep their text", () => {
    expect(displayUrl("Claude Code")).toBe("Claude Code");
    expect(displayUrl("github.com/a")).toBe("github.com/a");
    expect(displayUrl("javascript:alert(1)")).toBe("javascript:alert(1)");
    expect(displayUrl("ftp://host/x")).toBe("ftp://host/x");
    expect(displayUrl("https://evil com")).toBe("https://evil com");
    expect(displayUrl("say https:// in the middle")).toBe("say https:// in the middle");
  });

  it("documents the collisions the web diff guard relies on: differing values, equal display", () => {
    const pairs: [string, string][] = [
      ["https://good.com@evil.com", "https://evil.com"],
      ["https://GitHub.com/x", "https://github.com/x"],
      ["https://a.com:443/x", "https://a.com/x"],
      ["https://x", "x"],
    ];
    for (const [a, b] of pairs) {
      expect(displayUrl(a)).toBe(displayUrl(b));
    }
  });
});
