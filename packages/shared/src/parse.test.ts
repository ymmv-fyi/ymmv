import { describe, expect, it } from "vitest";
import { ProfileParseError, parseProfile } from "./parse.js";
import { SCHEMA_VERSION } from "./types.js";

const valid = {
  schema_version: SCHEMA_VERSION,
  handle: "carol",
  entries: [{ key: "editor", value: "Vim" }],
  extras: [{ label: "Keyboard", value: "HHKB Pro 2" }],
  updated_at: "2026-06-30T00:00:00Z",
};

describe("parseProfile", () => {
  it("returns a typed Profile for a conforming payload", () => {
    expect(parseProfile(structuredClone(valid))).toEqual(valid);
  });

  it("throws ProfileParseError (not a TypeError crash) when entries is null", () => {
    // The exact Trigger: a non-conforming origin returns entries:null. Without the guard, diff()'s
    // `for (const entry of null)` throws an uncaught TypeError and crashes the CLI.
    expect(() => parseProfile({ ...valid, entries: null })).toThrow(ProfileParseError);
  });

  it("throws when extras is null", () => {
    expect(() => parseProfile({ ...valid, extras: null })).toThrow(ProfileParseError);
  });

  it("throws when entries is a non-array", () => {
    expect(() => parseProfile({ ...valid, entries: "nope" })).toThrow(ProfileParseError);
  });

  it("throws when an entry is not {key,value} strings", () => {
    expect(() => parseProfile({ ...valid, entries: [{ key: "editor", value: 123 }] })).toThrow(
      ProfileParseError,
    );
  });

  it("throws when an extra is not {label,value} strings", () => {
    expect(() => parseProfile({ ...valid, extras: [{ label: "x" }] })).toThrow(ProfileParseError);
  });

  it("throws on a schema_version mismatch", () => {
    expect(() => parseProfile({ ...valid, schema_version: 2 })).toThrow(ProfileParseError);
  });

  it("schema mismatch carries the upgrade instruction", () => {
    // The dominant stale-CLI experience after a server-side bump is this read-path throw, not the
    // publish 400 — so the upgrade copy must live in the message itself.
    expect(() => parseProfile({ ...valid, schema_version: 2 })).toThrow(
      /unsupported schema_version: 2\. Upgrade the ymmv CLI \(npm i -g ymmv-cli\)\./,
    );
  });

  it("caps a hostile wire schema_version in the error message (no terminal flooding)", () => {
    // This check runs BEFORE the MAX_PARSE_* ceilings, so the message must bound the echo itself.
    const err = (() => {
      try {
        parseProfile({ ...valid, schema_version: "x".repeat(10_000) });
      } catch (e) {
        return e as Error;
      }
      return new Error("did not throw");
    })();
    expect(err).toBeInstanceOf(ProfileParseError);
    expect(err.message.length).toBeLessThan(200);
    expect(err.message).toMatch(/Upgrade the ymmv CLI/);
  });

  it("throws when handle is missing / not a string", () => {
    expect(() => parseProfile({ ...valid, handle: undefined })).toThrow(ProfileParseError);
  });

  it("throws when the top-level value is not an object", () => {
    expect(() => parseProfile(null)).toThrow(ProfileParseError);
    expect(() => parseProfile("string")).toThrow(ProfileParseError);
  });

  it("throws when entries exceed the defensive count ceiling", () => {
    const many = Array.from({ length: 257 }, () => ({ key: "editor", value: "x" }));
    expect(() => parseProfile({ ...valid, entries: many })).toThrow(ProfileParseError);
  });

  it("throws when a value exceeds the defensive length ceiling", () => {
    const huge = "x".repeat(4097);
    expect(() => parseProfile({ ...valid, entries: [{ key: "editor", value: huge }] })).toThrow(
      ProfileParseError,
    );
  });

  // Every Profile string the terminal sanitizer scans is bounded, not just entry.value:
  // showCard prints e.key, and commands.ts prints sanitizeValue(existing.handle).
  it("throws when an entry key exceeds the defensive length ceiling", () => {
    const huge = "x".repeat(4097);
    expect(() => parseProfile({ ...valid, entries: [{ key: huge, value: "v" }] })).toThrow(
      ProfileParseError,
    );
  });

  it("throws when handle exceeds the defensive length ceiling", () => {
    expect(() => parseProfile({ ...valid, handle: "x".repeat(4097) })).toThrow(ProfileParseError);
  });

  it("throws when updated_at exceeds the defensive length ceiling", () => {
    expect(() => parseProfile({ ...valid, updated_at: "x".repeat(4097) })).toThrow(
      ProfileParseError,
    );
  });

  it("accepts key/handle/updated_at exactly at the ceiling (boundary)", () => {
    const max = "x".repeat(4096);
    expect(() => parseProfile({ ...valid, entries: [{ key: max, value: "v" }] })).not.toThrow();
    expect(() => parseProfile({ ...valid, handle: max })).not.toThrow();
    expect(() => parseProfile({ ...valid, updated_at: max })).not.toThrow();
  });

  it("throws on a sparse-array entries (holes must not bypass per-element validation)", () => {
    // `.map` would skip the holes and return a sparse Profile; an index loop must reject them.
    expect(() => parseProfile({ ...valid, entries: Array(3) })).toThrow(ProfileParseError);
  });

  it("throws on a sparse-array extras", () => {
    expect(() => parseProfile({ ...valid, extras: Array(2) })).toThrow(ProfileParseError);
  });

  it("preserves a non-curated key verbatim (shape guard, not taxonomy)", () => {
    const p = parseProfile({ ...valid, entries: [{ key: "not-curated", value: "v" }] });
    expect(p.entries).toEqual([{ key: "not-curated", value: "v" }]);
  });
});
