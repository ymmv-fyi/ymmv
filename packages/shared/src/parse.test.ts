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
