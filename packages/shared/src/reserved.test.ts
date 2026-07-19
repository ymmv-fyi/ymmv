import { describe, expect, it } from "vitest";
import { CLI_VERBS, isReserved, isValidHandle, RESERVED, RESERVED_ROUTES } from "./reserved.js";

describe("isReserved()", () => {
  it("reserves every root route and CLI verb", () => {
    for (const name of [...RESERVED_ROUTES, ...CLI_VERBS]) {
      expect(isReserved(name)).toBe(true);
    }
  });

  it("is case-insensitive", () => {
    expect(isReserved("API")).toBe(true);
    expect(isReserved("Login")).toBe(true);
  });

  it("reserves 404 — the static page route shadows the dynamic [handle] page", () => {
    // `404` is a valid GitHub login, so without this the handle is claimable while
    // /404 renders the not-found page and /api/v1/u/404 serves the profile JSON.
    expect(isValidHandle("404")).toBe(true);
    expect(isReserved("404")).toBe(true);
  });

  it("reserves version and publish — command words users predictably type as verbs", () => {
    // Both are valid GitHub logins; unreserved they'd be squattable profile views for
    // everyone typing `ymmv version` / `ymmv publish` expecting the command.
    expect(isValidHandle("version")).toBe(true);
    expect(isReserved("version")).toBe(true);
    expect(isValidHandle("publish")).toBe(true);
    expect(isReserved("publish")).toBe(true);
  });

  it("does not reserve an ordinary handle", () => {
    expect(isReserved("antfu")).toBe(false);
    expect(isReserved("bah")).toBe(false);
  });

  it("RESERVED is de-duplicated (login/logout appear in both sources)", () => {
    expect(new Set(RESERVED).size).toBe(RESERVED.length);
  });
});

describe("isValidHandle()", () => {
  it("accepts normal handles", () => {
    for (const h of ["a", "antfu", "torvalds", "a-b", "user123", "a".repeat(39)]) {
      expect(isValidHandle(h)).toBe(true);
    }
  });

  it("39 chars ok, 40 rejected (boundary)", () => {
    expect(isValidHandle("a".repeat(39))).toBe(true);
    expect(isValidHandle("a".repeat(40))).toBe(false);
  });

  it("rejects leading and trailing hyphen", () => {
    expect(isValidHandle("-bad")).toBe(false);
    expect(isValidHandle("bad-")).toBe(false);
  });

  it("rejects consecutive hyphens", () => {
    expect(isValidHandle("a--b")).toBe(false);
  });

  it("rejects empty and non-ASCII", () => {
    expect(isValidHandle("")).toBe(false);
    expect(isValidHandle("café")).toBe(false);
    expect(isValidHandle("naïve")).toBe(false);
  });

  it("rejects dots and underscores (Astro/static internals can never be handles)", () => {
    expect(isValidHandle("_astro")).toBe(false);
    expect(isValidHandle("favicon.ico")).toBe(false);
    expect(isValidHandle("robots.txt")).toBe(false);
  });
});
