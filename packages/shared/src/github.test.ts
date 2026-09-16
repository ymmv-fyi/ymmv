import { describe, expect, it } from "vitest";
import { GITHUB_CLIENT_ID, isGithubId } from "./github.js";

describe("GITHUB_CLIENT_ID", () => {
  it("is the pinned public client id of the ymmv OAuth app (single source for CLI + Worker)", () => {
    // Pinning the value guards the CLI↔Worker contract: the device flow and the Worker's
    // introspection MUST target the same app, or every login 404s at introspection.
    expect(GITHUB_CLIENT_ID).toBe("Ov23liMoD29eizQcN1KZ");
  });

  it("is a non-empty alphanumeric string (guards accidental blanking that would break all logins)", () => {
    expect(typeof GITHUB_CLIENT_ID).toBe("string");
    expect(GITHUB_CLIENT_ID.length).toBeGreaterThan(0);
    expect(/^[A-Za-z0-9]+$/.test(GITHUB_CLIENT_ID)).toBe(true);
  });
});

describe("isGithubId", () => {
  it("accepts a positive safe integer (what GitHub issues)", () => {
    expect(isGithubId(1)).toBe(true);
    expect(isGithubId(4242)).toBe(true);
    expect(isGithubId(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("rejects zero, negatives, fractions, unsafe integers, and non-numbers", () => {
    // One rule for the Worker's introspection parse, the CLI's mint parse, and the token store —
    // anything one side lets through must not be a value another side chokes on.
    for (const bad of [0, -1, 1.5, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isGithubId(bad)).toBe(false);
    }
    for (const bad of ["1", "4242", null, undefined, true, {}, [], 4242n]) {
      expect(isGithubId(bad)).toBe(false);
    }
  });
});
