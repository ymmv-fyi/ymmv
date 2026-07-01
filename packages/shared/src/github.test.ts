import { describe, expect, it } from "vitest";
import { GITHUB_CLIENT_ID } from "./github.js";

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
